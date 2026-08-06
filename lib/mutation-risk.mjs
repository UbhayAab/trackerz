// RISK TIERS for a model-emitted mutation - what it costs to be WRONG, not how
// sure the model claims to be.
//
// Confidence gating is already dead here (AUTO_APPLY_MIN_CONFIDENCE = 0 in the
// agent edge function, and `confidencePolicy` only tags `reasons`), and reviving
// it would gate the wrong thing anyway: a 0.95-confidence permanent plan rewrite
// is far more dangerous than a 0.6 food log. One is a typo you delete from the
// feed; the other silently replaces the standing setup that every later capture,
// every checklist tick and every brief is then read against. The 2026-08-06
// incident is the proof - the model routed a diet instruction PERFECTLY at 0.95
// and the damage came from what the app did with that write, not from doubt.
//
// Four tiers:
//   reversible    - the create_*_log inserts. One row, one tap to delete, no
//                   other row's meaning changes. AUTO-APPLY, unchanged: this is
//                   the deliberate capture-first product choice and gating it
//                   would put a confirmation in front of the 95% case.
//   consequential - rewrites the standing setup (permanent plan, targets,
//                   durable memory, a recurring calendar rule). CONFIRM.
//   destructive   - amend / delete / merge: it destroys or rewrites something
//                   already recorded. CONFIRM, and soft-delete only.
//   external      - anything that escapes the app (send, pay, share, publish).
//                   CONFIRM. Nothing here exists yet; the tier does, so the day
//                   one is added it cannot land on the auto path by omission.
//
// Pure (no DOM, no Supabase, no Deno). MIRRORED byte-identically into
// supabase/functions/agent/index.ts - run `node scripts/sync-mirror.mjs` after
// editing the block below.

// isStandingChange is the permanent-vs-dated distinction, learned the hard way in
// BOTH directions (see the comment on it). It is NOT duplicated here: lib/ imports
// it, and the edge function's mirror block resolves to the edge's own copy of the
// same function.
import { isStandingChange } from "./fan-out-expander.mjs";

// ==== MUTATION-RISK MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====
var MUTATION_TIERS = ["reversible", "consequential", "destructive", "external"];

// How long a soft-confirmed write stays undoable in the toast. Long enough to
// read the sentence it just wrote, short enough not to sit on screen.
var UNDO_TOAST_MS = 15000;

// The registered tools, by tier. Membership is explicit rather than inferred from
// the name so that adding a tool is a decision someone made, not a regex outcome.
var REVERSIBLE_TOOLS = [
  "create_expense_candidate", "create_income_candidate", "create_transfer_candidate",
  "create_statement_row_candidate", "create_food_log_candidate", "create_workout_log_candidate",
  "create_body_metric_candidate", "create_wellness_note_candidate", "create_hydration_candidate",
  "create_sleep_candidate", "create_note_candidate",
];
var CONSEQUENTIAL_TOOLS = [
  // A target is a goal every pace calculation is measured against.
  "set_target_candidate",
  // A durable fact is replayed into EVERY later prompt, so a wrong one compounds
  // instead of decaying with the capture that made it.
  "remember_fact",
  // A reminder is a rule that fires again; a wrong one is a wrong notification
  // every year until someone notices.
  "create_reminder_candidate",
  // Commits a previously proposed action - it inherits that action's blast
  // radius, so it can never be lighter than consequential.
  "apply_verified_action",
];
var DESTRUCTIVE_TOOLS = [
  // A merge deletes the loser of a duplicate pair.
  "link_duplicate_candidates",
  // An undo removes rows that are already in the user's totals.
  "undo_ai_action",
];
// Tools that write nothing at all. They carry a question or an answer back to the
// UI, so they are on the auto path with the reversible inserts.
var NON_MUTATING_TOOLS = ["request_user_review", "answer_question", "estimate_food_macros"];

// Name shapes for tools that do not exist yet. The DEFAULT for an unrecognised
// name is `destructive`, so a tool added without a tier entry fails CLOSED
// (confirm) rather than open - but a `send_*` still has to read as external, or
// the day someone adds one it would be gated as merely destructive.
var EXTERNAL_NAME = /^(send|email|mail|notify|pay|share|post|publish|sms|call|export|upload|webhook|order|book)[_-]/;
var DESTRUCTIVE_NAME = /^(delete|remove|drop|purge|merge|amend|edit|correct|overwrite|reset|clear|unlink|archive)[_-]/;

function mutationTier(tc) {
  var name = tc && tc.name ? String(tc.name) : "";
  if (!name) return "destructive";
  if (EXTERNAL_NAME.test(name)) return "external";
  if (DESTRUCTIVE_TOOLS.indexOf(name) >= 0) return "destructive";
  // The one tool whose tier depends on its ARGUMENTS, not its name. A permanent
  // plan rewrite replaces the standing setup; a date-scoped delta bends one named
  // day and is undone by deleting one row.
  if (name === "update_plan_candidate") {
    return isStandingChange(tc) ? "consequential" : "reversible";
  }
  if (CONSEQUENTIAL_TOOLS.indexOf(name) >= 0) return "consequential";
  if (REVERSIBLE_TOOLS.indexOf(name) >= 0) return "reversible";
  if (NON_MUTATING_TOOLS.indexOf(name) >= 0) return "reversible";
  if (DESTRUCTIVE_NAME.test(name)) return "destructive";
  return "destructive";
}

// What the UI has to do before the write counts as accepted.
//   "auto" - write it, no extra affordance beyond the feed row and its delete.
//   "soft" - write it NOW and show an undo toast for UNDO_TOAST_MS.
//   "hard" - do NOT write; render the diff card and wait for a tap.
function mutationGate(tc) {
  var tier = mutationTier(tc);
  if (tier !== "reversible") return "hard";
  // The refinement that keeps the fast path fast. "Swap today's leg day for
  // cardio" is one day of one plan: a diff card there is friction with nothing
  // behind it, and the LOG-THAT-CONTRADICTS-THE-PLAN rule deliberately emits one
  // of these ALONGSIDE a real log, so gating it would stall an ordinary capture.
  if (tc && tc.name === "update_plan_candidate") return "soft";
  return "auto";
}

function mutationRisk(tc) {
  var tier = mutationTier(tc);
  var gate = mutationGate(tc);
  return {
    tier: tier,
    gate: gate,
    undoToastMs: gate === "soft" ? UNDO_TOAST_MS : 0,
    // Destructive means soft-delete only. The LLM gets NO hard-delete path at any
    // tier - a purge is a maintenance job on rows already tombstoned for 30 days.
    softDeleteOnly: tier === "destructive",
  };
}

function requiresConfirmation(tc) {
  return mutationGate(tc) === "hard";
}

// Rank within MUTATION_TIERS - "above reversible" is rank > 0.
function tierRank(tier) {
  var i = MUTATION_TIERS.indexOf(tier);
  return i < 0 ? MUTATION_TIERS.length : i;
}

// THE INVARIANT, in one function so it can be asserted rather than described:
// in an autonomous context (no human at the other end of the round trip) nothing
// above `reversible` may apply itself.
function canAutoApply(tc) {
  return tierRank(mutationTier(tc)) === 0 && mutationGate(tc) !== "hard";
}
// ==== MUTATION-RISK MIRROR END ====

export {
  MUTATION_TIERS, UNDO_TOAST_MS,
  REVERSIBLE_TOOLS, CONSEQUENTIAL_TOOLS, DESTRUCTIVE_TOOLS, NON_MUTATING_TOOLS,
  mutationTier, mutationGate, mutationRisk, requiresConfirmation, tierRank, canAutoApply,
};
