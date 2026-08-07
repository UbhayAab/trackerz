import assert from "node:assert/strict";
import { decideActionPolicy, autonomousViolations } from "../src/agent/action-policy.js";
import { buildSystemBoundary } from "../src/agent/prompt-boundaries.js";
import { chooseModelRoute } from "../src/agent/model-router.js";
import { toolRegistry } from "../src/agent/tool-registry.js";
import { filterAutonomousActions } from "../lib/agent-tasks.mjs";
import {
  mutationTier, mutationGate, mutationRisk, canAutoApply, tierRank, MUTATION_TIERS, UNDO_TOAST_MS,
} from "../lib/mutation-risk.mjs";

assert.equal(
  decideActionPolicy({
    name: "create_expense_candidate",
    confidence: 0.94,
    evidenceId: "ev_1",
  }).mode,
  "auto_apply",
);

// No approve gate any more: a non-blocked action auto-commits even without an
// evidenceId. The `reasons` still carry the flag so the UI can mark it.
const lowEvidence = decideActionPolicy({
  name: "create_expense_candidate",
  confidence: 0.91,
});
assert.equal(lowEvidence.mode, "auto_apply");
assert.ok(lowEvidence.reasons.includes("missing_evidence"));

assert.equal(
  decideActionPolicy({
    name: "drop_all_tables",
    confidence: 1,
    evidenceId: "ev_1",
  }).mode,
  "block",
);

assert.equal(chooseModelRoute({ inputKind: "statement" }).extractor, "deterministic-parser");
assert.equal(chooseModelRoute({ inputKind: "image", risk: "high" }).extractor, "gemini-3.1-pro-preview");
assert.ok(buildSystemBoundary().includes("untrusted evidence"));

console.log("agent policy tests passed");

// ---------------------------------------------------------------------------
// 2026-08-04: a required field under a near-miss NAME is not a missing field.
// Rejecting the call did not just lose it - the deterministic salvage then
// synthesized a cruder replacement that DID apply, so the detailed row lost to
// the crude one. Measured 2026-08-03: a cardio log carrying 21.43 min / 2.3 km /
// 216 kcal under `name`+`notes` was rejected for `required:description`, and what
// landed was the raw OCR blob with none of those numbers.
// ---------------------------------------------------------------------------
{
  const { validateToolArguments, repairToolArguments } = await import("../src/agent/tool-schemas.js");
  const NOW = "2026-08-03T09:16:37.810Z";
  const repaired = (name, args) => repairToolArguments(name, { ...args }, NOW);

  // The real rejected call, verbatim.
  const cardio = repaired("create_workout_log_candidate", {
    kind: "cardio", name: "Cardio machine session",
    notes: "Resistance 17, speed 6.1 km/h, power 111 W, cadence 31 RPM, METs 5.5",
    distance_km: 2.3, occurred_at: NOW, duration_min: 21.43, calories_burned: 216,
  });
  assert.ok(validateToolArguments("create_workout_log_candidate", cardio).ok, "name fills description");
  assert.match(cardio.description, /Cardio machine session/, "the label survives");
  assert.match(cardio.description, /Resistance 17/, "and so does the readout in notes");
  assert.equal(cardio.duration_min, 21.43, "the measured duration is kept, not discarded");

  // The real 2026-07-29 food rejection: no occurred_at at all.
  const food = repaired("create_food_log_candidate", { meal_slot: "snack", description: "6 boiled eggs", calories_estimate: 432 });
  assert.ok(validateToolArguments("create_food_log_candidate", food).ok, "an untimed capture happened now");
  assert.equal(food.occurred_at, NOW);

  // Amount aliases on money.
  const spend = repaired("create_expense_candidate", { value: 350, merchant: "Rolls", occurred_at: NOW });
  assert.ok(validateToolArguments("create_expense_candidate", spend).ok, "value fills amount");
  assert.equal(spend.amount, 350);

  // A value the model DID supply is never overwritten.
  const keep = repaired("create_food_log_candidate", { description: "real one", name: "alias one", occurred_at: NOW });
  assert.equal(keep.description, "real one", "repair never clobbers a supplied value");

  // Repair is not a licence to invent: nothing to fill means still invalid.
  const empty = repaired("create_expense_candidate", { merchant: "Unknown", occurred_at: NOW });
  assert.ok(!validateToolArguments("create_expense_candidate", empty).ok, "no alias, no amount - stays rejected");
}

console.log("tool-argument repair tests passed");

// ---------------------------------------------------------------------------
// RISK TIERS + the confirm gate.
//
// Before this, decideActionPolicy returned only `block | auto_apply`, so a
// permanent plan rewrite at 0.95 confidence and a 100 ml water log were treated
// identically: both committed silently. The tier decides now, not the confidence.
// ---------------------------------------------------------------------------
{
  const A = (name, args) => ({ name, confidence: 0.9, evidenceId: "ev_1", arguments: args || {} });

  // --- the full tier matrix, tool by tool ---
  const EXPECTED = [
    // reversible: one row, one tap to delete. Auto-applies, unchanged.
    ["create_expense_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_income_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_transfer_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_statement_row_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_food_log_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_workout_log_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_body_metric_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_wellness_note_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_hydration_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_sleep_candidate", {}, "reversible", "auto", "auto_apply"],
    ["create_note_candidate", {}, "reversible", "auto", "auto_apply"],
    // non-writing tools ride the auto path with them
    ["request_user_review", {}, "reversible", "auto", "auto_apply"],
    ["answer_question", {}, "reversible", "auto", "auto_apply"],
    // CONSEQUENTIAL, BUT SOFT: written immediately, with an undo. These were all
    // "hard" for a day and it was the wrong call - the owner's instruction was
    // "auto-apply, but plan rewrites need two signals", and gating a birthday, a
    // remembered preference and a reminder behind a tap turned the feed into a
    // review queue nobody cleared. A queue nobody clears is indistinguishable
    // from the app not working, and that is how it got reported.
    //
    // Undo beats confirm whenever the action is reversible and the app is usually
    // right: the cost moves from a tap before every CORRECT action to a tap after
    // the occasional wrong one.
    ["set_target_candidate", { kind: "daily_protein", amount: 180 }, "consequential", "soft", "auto_apply"],
    ["remember_fact", { key: "usual_lunch", value: "egg curry" }, "consequential", "soft", "auto_apply"],
    ["create_reminder_candidate", { title: "Mom's birthday", freq: "yearly" }, "consequential", "soft", "auto_apply"],
    // THE TWO SIGNALS RULE, still hard and still explicit: a PERMANENT plan
    // rewrite replaces the standing setup that every later capture, checklist tick
    // and brief is then read against.
    ["update_plan_candidate", { kind: "diet", scope: "permanent" }, "consequential", "hard", "confirm"],
    // an ABSENT scope reads as permanent, because applyTool defaults it that way
    ["update_plan_candidate", { kind: "diet" }, "consequential", "hard", "confirm"],
    // a DATED plan change bends one named day and is undone by deleting one row
    ["update_plan_candidate", { kind: "diet", scope: "2026-08-07" }, "reversible", "soft", "auto_apply"],
    // destructive: a merge deletes the loser of a duplicate pair
    ["link_duplicate_candidates", {}, "destructive", "hard", "confirm"],
  ];
  for (const [name, args, tier, gate, mode] of EXPECTED) {
    const action = A(name, args);
    assert.equal(mutationTier(action), tier, `${name} tier`);
    assert.equal(mutationGate(action), gate, `${name} gate`);
    assert.equal(decideActionPolicy(action).mode, mode, `${name} mode`);
  }

  // The refinement that keeps the fast path fast: a DATE-SCOPED plan delta stays
  // reversible - it applies now with a 15-second undo toast, because the
  // LOG-THAT-CONTRADICTS-THE-PLAN rule emits one of these alongside a real log
  // and gating it would stall an ordinary capture.
  const dated = A("update_plan_candidate", { kind: "gym", scope: "2026-08-06", payload: { op: "replace_workout" } });
  assert.equal(mutationTier(dated), "reversible");
  assert.equal(mutationGate(dated), "soft");
  const datedDecision = decideActionPolicy(dated);
  assert.equal(datedDecision.mode, "auto_apply", "a one-day plan change is not gated");
  assert.equal(datedDecision.undoToastMs, UNDO_TOAST_MS, "but it carries an undo toast");
  assert.equal(mutationRisk(dated).undoToastMs, 15000);

  // A comma-separated date list ("next 4 Mondays") is still dated, not permanent.
  assert.equal(mutationTier(A("update_plan_candidate", { scope: "2026-08-10,2026-08-17" })), "reversible");

  // --- fail closed -----------------------------------------------------------
  // A tool nobody classified is DESTRUCTIVE, not reversible. Adding a tool
  // without a tier entry must cost a confirmation, never a silent write.
  assert.equal(mutationTier({ name: "obliterate_everything" }), "destructive");
  assert.equal(mutationTier({ name: "delete_food_log" }), "destructive");
  assert.equal(mutationTier({ name: "amend_expense" }), "destructive");
  assert.equal(mutationTier({ name: "merge_entries" }), "destructive");
  // Anything that leaves the app is `external` even before it exists, so it can
  // never be gated as "merely destructive" the day someone adds one.
  assert.equal(mutationTier({ name: "send_email" }), "external");
  assert.equal(mutationTier({ name: "pay_merchant" }), "external");
  assert.equal(mutationTier({ name: "share_report" }), "external");
  assert.equal(mutationTier({}), "destructive", "a nameless call is not reversible");

  // Destructive means SOFT-DELETE ONLY - the model gets no hard-delete path.
  assert.equal(mutationRisk({ name: "delete_food_log" }).softDeleteOnly, true);
  assert.equal(mutationRisk(A("create_food_log_candidate")).softDeleteOnly, false);

  // --- THE INVARIANT ---------------------------------------------------------
  // Stated separately for the two contexts, because they are not the same
  // question and conflating them is what produced a review queue for a birthday.
  //
  // INTERACTIVE: the owner just typed it and is watching the feed. Nothing above
  // reversible may commit SILENTLY, but "soft" - write now, show an undo - is a
  // legitimate answer and the right one for anything a single tap can reverse.
  // The bar here is that it must never be plain `auto`.
  //
  // AUTONOMOUS: a scheduled run at 03:00 with nobody watching. THAT is where
  // nothing above reversible may apply itself, and it is enforced by the narrow
  // allowlist in lib/agent-tasks.mjs rather than by the gate - asserted below
  // against the registry so a tool added later is covered without anyone
  // remembering to extend this.
  for (const tool of toolRegistry) {
    const action = A(tool.name, tool.name === "update_plan_candidate" ? { scope: "permanent" } : {});
    const decision = decideActionPolicy(action);
    if (tierRank(decision.tier) > 0) {
      assert.notEqual(mutationGate(action), "auto",
        `${tool.name} is above reversible and must not commit silently - soft (undo) or hard (confirm), never auto`);
      assert.equal(canAutoApply(action), false, `${tool.name} must fail canAutoApply`);
    } else {
      assert.notEqual(decision.mode, "block", `${tool.name} is registered and reversible - it must not be blocked`);
    }
  }

  // The autonomous half of the same invariant, at its real enforcement point.
  {
    const calls = toolRegistry.map((t) => ({
      name: t.name,
      arguments: t.name === "update_plan_candidate" ? { scope: "permanent" } : {},
    }));
    const { allowed } = filterAutonomousActions(calls, 0);
    for (const c of allowed) {
      assert.equal(tierRank(mutationTier(c)), 0,
        `${c.name} survived the autonomous allowlist but is above reversible`);
    }
  }
  // autonomousViolations reports what would commit without a human present. Since
  // the consequential tools became SOFT - written immediately with an undo - they
  // now correctly appear here: an undo toast at 03:00 is nobody watching. The
  // property that matters is not that the list is empty, it is that EVERY entry on
  // it is stopped by the autonomous allowlist before it can run.
  {
    const all = toolRegistry.map((t) => A(t.name, t.name === "update_plan_candidate" ? { scope: "permanent" } : {}));
    const flagged = autonomousViolations(all);
    const { allowed } = filterAutonomousActions(all, 0);
    const allowedNames = new Set(allowed.map((c) => c.name));
    for (const v of flagged) {
      assert.equal(allowedNames.has(v.name), false,
        `${v.name} would commit unattended and the autonomous allowlist lets it through`);
    }
    // And the reverse, so the allowlist cannot quietly widen: nothing it permits
    // is above reversible.
    for (const c of allowed) {
      assert.equal(tierRank(mutationTier(c)), 0, `${c.name} is allowed autonomously but is above reversible`);
    }
  }

  // Block still outranks everything: an unknown tool never reaches the tiers.
  assert.equal(decideActionPolicy({ name: "drop_all_tables", confidence: 1, evidenceId: "x" }).mode, "block");

  // Confirm carries a reason the UI can render, and the mode set is closed.
  // Uses a PERMANENT plan rewrite, which is the case that still confirms; a
  // target is soft now and would have no confirm reason to carry.
  const confirmDecision = decideActionPolicy(A("update_plan_candidate", { kind: "diet", scope: "permanent" }));
  assert.equal(confirmDecision.mode, "confirm");
  assert.ok(confirmDecision.reasons.includes("confirm_consequential"));
  assert.ok(MUTATION_TIERS.includes(confirmDecision.tier));

  // A SOFT decision must still say it is soft, or the UI has no way to know an
  // undo is owed and the write lands with no affordance at all - which is worse
  // than the confirm it replaced.
  const softDecision = decideActionPolicy(A("set_target_candidate", { kind: "daily_protein", amount: 180 }));
  assert.equal(softDecision.mode, "auto_apply");
  assert.equal(softDecision.gate, "soft", "a consequential write must be marked soft so the UI offers an undo");

  // Low confidence does NOT gate a reversible capture - capture-first is the
  // product, and the old confidence gate is still dead on purpose.
  assert.equal(decideActionPolicy({ name: "create_food_log_candidate", confidence: 0.1 }).mode, "auto_apply");
  // ...and high confidence does NOT un-gate the one thing that stays hard.
  assert.equal(
    decideActionPolicy({ name: "update_plan_candidate", confidence: 0.99, evidenceId: "ev", arguments: { kind: "diet", scope: "permanent" } }).mode,
    "confirm",
    "0.99 confidence is not permission to replace the standing plan",
  );
  // And an amendment stays hard at any confidence: it rewrites a row already in
  // the totals, which is the one error nobody goes looking for.
  assert.equal(
    decideActionPolicy({ name: "amend_log_candidate", confidence: 0.99, evidenceId: "ev", arguments: { target_ref: "30 g bhujia" } }).mode,
    "confirm",
    "an amendment always shows its diff",
  );
}

console.log("mutation-risk + confirm-gate tests passed");
