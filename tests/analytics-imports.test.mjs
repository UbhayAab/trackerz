import assert from "node:assert/strict";
import { getBudgetPace } from "../src/analytics/budget-trajectory.js";
import { computeHabitScore } from "../src/analytics/habit-score.js";
import { computeHabitScore as domainHabitScore } from "../src/domain/wellness/habit-score.js";
import { computeMacroGap } from "../src/analytics/macro-pace.js";
import { buildStatementPreview } from "../src/imports/statement-preview.js";
import { normalizeStatementRow } from "../src/imports/row-normalizer.js";
import { scoreFoodDuplicate } from "../src/duplicates/food-duplicates.js";

assert.equal(getBudgetPace({ spentSoFar: 5000, budget: 15000, dayOfMonth: 10 }).projected, 15000);
// There is exactly ONE habit scorer: src/analytics/habit-score.js used to hold a
// rival implementation (pre-normalised metrics x habit-weights.js, including a
// `hydration` weight nothing fed) that disagreed with the domain scorer weekly
// reviews read. The analytics path is now a re-export of that one scorer.
assert.equal(computeHabitScore, domainHabitScore, "one computeHabitScore implementation, re-exported");
{
  const habit = computeHabitScore({ todayISO: "2026-05-11T00:00:00Z" });
  assert.ok(typeof habit.score === "number" && habit.score >= 0 && habit.score <= 100);
  assert.equal(habit.components.reduce((sum, c) => sum + c.weight, 0), 100, "component weights sum to 100");
  assert.ok(!habit.components.some((c) => c.name === "hydration"), "no phantom hydration component");
}
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
