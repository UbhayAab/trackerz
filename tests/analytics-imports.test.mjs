import assert from "node:assert/strict";
import { getBudgetPace } from "../src/analytics/budget-trajectory.js";
import { computeHabitScore } from "../src/analytics/habit-score.js";
import { computeMacroGap } from "../src/analytics/macro-pace.js";
import { buildStatementPreview } from "../src/imports/statement-preview.js";
import { normalizeStatementRow } from "../src/imports/row-normalizer.js";
import { scoreFoodDuplicate } from "../src/duplicates/food-duplicates.js";

assert.equal(getBudgetPace({ spentSoFar: 5000, budget: 15000, dayOfMonth: 10 }).projected, 15000);
assert.equal(computeHabitScore({ protein: 80, sleep: 70, steps: 90, budget: 60, mood: 75 }), 75);
assert.deepEqual(computeMacroGap({ calories: 1600, protein: 90, targets: { calories: 2100, protein: 130 } }), {
  caloriesRemaining: 500,
  proteinRemaining: 40,
  proteinProgress: 90 / 130,
});

const preview = buildStatementPreview({
  filename: "hdfc-may.xlsx",
  headers: ["Txn Date", "Narration", "Withdrawal", "Deposit", "Balance"],
  rows: [{}, {}, {}],
});
assert.equal(preview.bank, "hdfc");
assert.equal(preview.rowCount, 3);
assert.equal(preview.needsReview, false);

const row = normalizeStatementRow(
  { Date: "2026-05-11", Details: "Zomato", Debit: "240", Credit: "", Balance: "1000" },
  { date: "Date", description: "Details", debit: "Debit", credit: "Credit", balance: "Balance" },
);
assert.equal(row.debit, 240);
assert.equal(row.credit, 0);

assert.equal(
  scoreFoodDuplicate(
    { mealSlot: "lunch", occurredAt: "2026-05-11T14:00:00+05:30", description: "dal rice curd" },
    { mealSlot: "lunch", occurredAt: "2026-05-11T14:35:00+05:30", description: "rice dal and sabzi" },
  ).isDuplicate,
  true,
);

console.log("analytics/import tests passed");
