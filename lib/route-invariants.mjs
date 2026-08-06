// ROUTE INVARIANTS: the rules that are enforced in CODE rather than hoped for in
// a prompt.
//
// The system prompt already says most of this. It says a change request must not
// log an event; it says a permanent plan change must be a full payload and never
// a delta. Both rules were already written, in capitals, and both were violated
// in production - because a prompt is a request and a validator is a contract.
//
// Every violation here is COUNTED, not just fixed. A rising
// `log_from_standing_language` count is the early warning that a model change has
// started drifting, and it arrives before the user notices a phantom meal.
//
// Pure: no DOM, no Supabase, no clock. Mirrored into the agent edge function.

// Tools that write a real event into a tracker.
export const LOG_TOOLS = new Set([
  "create_food_log_candidate",
  "create_workout_log_candidate",
  "create_expense_candidate",
  "create_income_candidate",
  "create_transfer_candidate",
  "create_hydration_candidate",
  "create_body_metric_candidate",
]);

// Tools that rewrite the user's standing setup.
export const PLAN_TOOLS = new Set(["update_plan_candidate", "set_target_candidate"]);

/**
 * Is this a plan change to the STANDING setup, as opposed to one named day?
 *
 * Load-bearing in both directions. A permanent change is a pure instruction and
 * may log nothing. A date-scoped delta is the opposite: the
 * LOG-THAT-CONTRADICTS-THE-PLAN rule deliberately pairs one with a real log, and
 * a bare denial ("...and no gym today") draws a same-day rest delta out of the
 * model while the same breath logs 500 g of curd.
 *
 * An absent scope counts as permanent because applyTool defaults it that way.
 */
export function isStandingChange(tc) {
  if (tc?.name === "set_target_candidate") return true;
  if (tc?.name !== "update_plan_candidate") return false;
  const scope = String(tc?.arguments?.scope || "").trim().toLowerCase();
  return !scope || scope === "permanent";
}


// The amendment cue lives with the amendment machinery. lib/ imports it; the
// edge function's mirror block resolves to the edge's own copy of the same
// function, which its AMEND-TARGET block already defines.
import { looksLikeAmendment } from "./amend-target.mjs";

// ==== ROUTE-INVARIANTS MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====
// Note: the edge copy reuses ITS OWN LOG_TOOLS and isStandingChange, which are
// already defined there for the fan-out expander. Only the block below is mirrored.

// Phrases that assert something is now true of every day. These are the ones the
// original PLAN_CHANGE_CUES list missed entirely, because it was written from the
// imperative side ("change my diet") and people mostly speak the declarative one
// (my-diet-has-changed, I-now-have-X-every-day). Keep this array free of quoted
// example prose: tests/mirror-parity extracts string literals by regex and cannot
// tell a marker from a comment.
const STANDING_MARKERS = [
  "every day", "everyday", "every single day", "daily", "from now on",
  "going forward", "now i", "i now", "has changed", "have changed",
  "switched to", "these days", "nowadays", "always", "usually",
  "my new", "no longer", "stopped eating", "stopped having",
  // Hinglish
  "ab se", "ab main", "ab mai", "roz", "rozana", "hamesha",
];

/**
 * Does this text assert a STANDING fact rather than report one occasion?
 *
 * "I now eat 6 eggs daily" names eggs and is not a meal. Naming a food is
 * evidence of DOMAIN, never evidence of OCCURRENCE - that single confusion
 * produced both phantom meals in this app's history.
 */
export function hasStandingLanguage(text = "") {
  const t = String(text || "").toLowerCase();
  return STANDING_MARKERS.some((m) => t.includes(m));
}

/** Is the payload a one-shot delta ({op:...}) rather than a full document? */
export function isDeltaPayload(payload) {
  return Boolean(payload && typeof payload === "object" && typeof payload.op === "string");
}

/**
 * Enforce the invariants over a set of tool calls.
 *
 * @param {object[]} calls
 * @param {{evidence?: string, carriesLoggedEvent?: boolean}} ctx
 * @returns {{calls: object[], violations: {code: string, tool: string}[]}}
 */
export function enforceRouteInvariants(calls = [], { evidence = "", carriesLoggedEvent = false } = {}) {
  let out = [...calls];
  const violations = [];

  const drop = (pred, code) => {
    const kept = [];
    for (const c of out) {
      if (pred(c)) violations.push({ code, tool: c?.name });
      else kept.push(c);
    }
    out = kept;
  };

  const standingChange = out.some(isStandingChange);
  const standingText = hasStandingLanguage(evidence);

  // I1. A capture that rewrites the standing setup may not also write a tracker
  //     row. 2026-08-06: update_plan_candidate at 0.95 arrived alongside a
  //     540 kcal meal built from the instruction text.
  if (standingChange && !carriesLoggedEvent) {
    drop((c) => LOG_TOOLS.has(c?.name), "log_in_standing_change");
  }

  // I2. Standing LANGUAGE is enough on its own, even when the model emitted no
  //     plan tool at all. This is the guard that works when the brain is
  //     unavailable and only the deterministic layers run.
  if (standingText && !carriesLoggedEvent && !standingChange) {
    drop((c) => LOG_TOOLS.has(c?.name), "log_from_standing_language");
  }

  // I3. A permanent scope may not carry a delta payload. The prompt says this in
  //     capitals and nothing enforced it; a delta written with scope
  //     "permanent" is inserted, reported as applied, and then silently ignored
  //     forever by the client, because sync.js drops permanent deltas.
  for (const c of out) {
    if (c?.name !== "update_plan_candidate") continue;
    const scope = String(c?.arguments?.scope || "").trim().toLowerCase();
    if ((!scope || scope === "permanent") && isDeltaPayload(c?.arguments?.payload)) {
      violations.push({ code: "permanent_delta", tool: c.name });
      // Do not drop it - a rejected plan change is a lost instruction. Mark it
      // so the caller can ask the model for a full payload instead.
      c.arguments._needs_full_plan = true;
    }
  }

  // I5. AN AMENDMENT NEEDS A CORRECTION IN THE SENTENCE.
  //
  //     Measured live on 2026-08-06, first try, against the deployed function:
  //     "30 g aloo bhujia zzverify220340" - a plain new snack, no correction
  //     word anywhere in it - came back as an amend_log_candidate REWRITING the
  //     existing 50 g aloo bhujia row, and the new snack was never logged at
  //     all. The model had the row in its memory context and the prompt had just
  //     taught it how to amend, so it amended.
  //
  //     That is the worst outcome this feature can produce and it is worse than
  //     not having the feature: an insert that becomes an edit loses one event
  //     and corrupts another, and nothing anywhere says so. The prompt already
  //     tells the model a correction has to be a correction. This is the
  //     contract version of that sentence.
  //
  //     Dropped, not demoted: the capture then falls through to the ordinary log
  //     path (the fan-out expander leaves salvage ON precisely because
  //     looksLikeAmendment said this is not a correction), so the snack lands as
  //     the insert it always was.
  if (!looksLikeAmendment(evidence)) {
    drop((c) => c?.name === "amend_log_candidate" || c?.name === "delete_log_candidate", "amend_without_correction");
  }

  // I4. A plan change that resolves to no change at all is a silent no-op
  //     reported as a success. `matched: 0` on a delta is the usual cause: the
  //     old fuzzy substring matcher would find nothing and quietly append.
  for (const c of out) {
    if (c?.name !== "update_plan_candidate") continue;
    const p = c?.arguments?.payload;
    const empty = !p || (typeof p === "object" && Object.keys(p).length === 0);
    if (empty) violations.push({ code: "empty_plan_change", tool: c.name });
  }

  return { calls: out, violations };
}
// ==== ROUTE-INVARIANTS MIRROR END ====
