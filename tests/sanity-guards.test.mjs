import assert from "node:assert/strict";
import { sanityCheck } from "../lib/sanity-guards.mjs";

const NOW = "2026-06-29T12:00:00+05:30";
const ok = (r) => assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
const flagged = (r, f) => { assert.equal(r.ok, false); assert.ok(r.flags.includes(f), `expected flag ${f}, got ${JSON.stringify(r.flags)}`); };

// ---------------------------------------------------------------------------
// plausible values pass clean (generous caps — no false positives)
// ---------------------------------------------------------------------------
ok(sanityCheck("create_expense_candidate", { amount: 250, occurred_at: NOW }, NOW));
ok(sanityCheck("create_expense_candidate", { amount: 150000, occurred_at: NOW }, NOW)); // a rent payment
ok(sanityCheck("create_food_log_candidate", { description: "feast", calories_estimate: 5500, protein_g: 120, occurred_at: NOW }, NOW));
ok(sanityCheck("create_body_metric_candidate", { metric_type: "weight", value: 84, occurred_at: NOW }, NOW));
ok(sanityCheck("create_body_metric_candidate", { metric_type: "steps", value: 80000, occurred_at: NOW }, NOW)); // a trek
ok(sanityCheck("create_workout_log_candidate", { description: "legs", duration_min: 75, occurred_at: NOW }, NOW));
ok(sanityCheck("set_target_candidate", { kind: "daily_protein", amount: 180 }, NOW));
ok(sanityCheck("create_income_candidate", { amount: 300000, occurred_at: NOW }, NOW)); // salary

// ---------------------------------------------------------------------------
// implausible values flag (the OCR/model-slip cases)
// ---------------------------------------------------------------------------
flagged(sanityCheck("create_expense_candidate", { amount: 540000, occurred_at: NOW }, NOW), "amount_too_large"); // Rs 540 -> 5,40,000 OCR slip
flagged(sanityCheck("create_food_log_candidate", { description: "x", calories_estimate: 50000, occurred_at: NOW }, NOW), "calories_implausible");
flagged(sanityCheck("create_food_log_candidate", { description: "x", protein_g: 9999, occurred_at: NOW }, NOW), "macros_implausible");
flagged(sanityCheck("create_body_metric_candidate", { metric_type: "weight", value: 600, occurred_at: NOW }, NOW), "weight_out_of_range");
flagged(sanityCheck("create_body_metric_candidate", { metric_type: "weight", value: 5, occurred_at: NOW }, NOW), "weight_out_of_range");
flagged(sanityCheck("create_body_metric_candidate", { metric_type: "steps", value: 5000000, occurred_at: NOW }, NOW), "steps_implausible");
flagged(sanityCheck("create_workout_log_candidate", { description: "x", duration_min: 5000, occurred_at: NOW }, NOW), "duration_implausible");
flagged(sanityCheck("set_target_candidate", { kind: "daily_calories", amount: 99999 }, NOW), "calories_implausible");

// ---------------------------------------------------------------------------
// date window
// ---------------------------------------------------------------------------
flagged(sanityCheck("create_expense_candidate", { amount: 100, occurred_at: "2031-01-01T00:00:00+05:30" }, NOW), "future_date");
flagged(sanityCheck("create_food_log_candidate", { description: "x", occurred_at: "2010-01-01T00:00:00+05:30" }, NOW), "ancient_date");
ok(sanityCheck("create_expense_candidate", { amount: 100, occurred_at: "2026-06-28T10:00:00+05:30" }, NOW)); // yesterday is fine

// ---------------------------------------------------------------------------
// contract: never throws, tag-only, pass-through for unknowns
// ---------------------------------------------------------------------------
ok(sanityCheck("request_user_review", { reason: "x" }, NOW));
ok(sanityCheck("create_body_metric_candidate", { metric_type: "body_fat_pct", value: 18, occurred_at: NOW }, NOW)); // unknown rule -> pass
ok(sanityCheck("create_expense_candidate", null, NOW));
ok(sanityCheck("create_expense_candidate", { amount: 100, occurred_at: NOW }, "garbage-clock")); // bad now -> still ok
ok(sanityCheck(undefined, undefined, undefined));

console.log("sanity-guards tests passed");
