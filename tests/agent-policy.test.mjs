import assert from "node:assert/strict";
import { decideActionPolicy } from "../src/agent/action-policy.js";
import { buildSystemBoundary } from "../src/agent/prompt-boundaries.js";
import { chooseModelRoute } from "../src/agent/model-router.js";

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
