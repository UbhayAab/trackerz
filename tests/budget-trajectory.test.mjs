// budget-trajectory.js was dead code (never imported) until it got wired into
// src/state/sync.js's budgetRows builder -- now load-bearing, needs real tests.
import assert from "node:assert/strict";
import { getBudgetPace, projectMonthlySpend } from "../src/analytics/budget-trajectory.js";

// projectMonthlySpend: linear extrapolation from spend-to-date.
assert.equal(projectMonthlySpend({ spentSoFar: 10000, dayOfMonth: 10, daysInMonth: 30 }), 30000);
assert.equal(projectMonthlySpend({ spentSoFar: 0, dayOfMonth: 10, daysInMonth: 30 }), 0, "no spend -> no projection");
assert.equal(projectMonthlySpend({ spentSoFar: 5000, dayOfMonth: 0, daysInMonth: 30 }), 0, "day 0 (guard against divide-by-zero) -> 0, not NaN/Infinity");

// getBudgetPace: on-pace, over-pace, under-pace.
{
  // Day 15 of 30, budget 30000 -> expected 15000 so far. Spent exactly that -> pace 1.0.
  const onPace = getBudgetPace({ spentSoFar: 15000, budget: 30000, dayOfMonth: 15, daysInMonth: 30 });
  assert.equal(onPace.expected, 15000);
  assert.equal(onPace.projected, 30000);
  assert.equal(onPace.pace, 1, "spent == expected -> pace exactly 1");
}
{
  // Same point in the month, but spent DOUBLE the expected -> over budget, pace 2.0.
  const over = getBudgetPace({ spentSoFar: 30000, budget: 30000, dayOfMonth: 15, daysInMonth: 30 });
  assert.equal(over.pace, 2, "double the expected spend -> pace 2");
  assert.equal(over.projected, 60000, "projected to blow past the budget");
}
{
  // Spent nothing yet -> pace 0, clearly "under".
  const under = getBudgetPace({ spentSoFar: 0, budget: 30000, dayOfMonth: 15, daysInMonth: 30 });
  assert.equal(under.pace, 0);
}
{
  // A weekly budget expressed via the same generic day-into-period/days-in-period
  // shape (day 3 of a 7-day week) -- exactly how src/state/sync.js's
  // periodWindow("weekly") feeds this function.
  const weekly = getBudgetPace({ spentSoFar: 4500, budget: 10500, dayOfMonth: 3, daysInMonth: 7 });
  assert.equal(weekly.expected, 4500);
  assert.equal(weekly.pace, 1);
}
{
  // Guard: dayOfMonth 0 (e.g. a brand new day boundary edge case) shouldn't throw
  // or divide by zero -- projectMonthlySpend already returns 0, expected follows.
  const edge = getBudgetPace({ spentSoFar: 500, budget: 10000, dayOfMonth: 0, daysInMonth: 30 });
  assert.equal(edge.expected, 0);
  assert.equal(edge.projected, 0);
  assert.equal(edge.pace, 0, "expected==0 -> pace falls back to 0, not divide-by-zero");
}

console.log("budget-trajectory tests passed");
