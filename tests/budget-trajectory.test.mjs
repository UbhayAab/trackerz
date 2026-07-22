// budget-trajectory.js was dead code (never imported) until it got wired into
// src/state/sync.js's budgetRows builder -- now load-bearing, needs real tests.
import assert from "node:assert/strict";
import {
  getBudgetPace,
  projectMonthlySpend,
  periodWindow,
  periodElapsedShare,
  monthToDateWindows,
} from "../src/analytics/budget-trajectory.js";

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

// periodWindow: ONE week definition (ISO Monday) for both the Money page and the
// budget-alert engine. Sunday is the day the two old definitions disagreed on --
// the alert engine restarted the week there while the page still counted it as
// day 7 of the week that began on Monday.
{
  const sunday = new Date(2026, 6, 26, 15, 0, 0); // Sun 26 Jul 2026, local
  const win = periodWindow("weekly", sunday);
  assert.equal(win.dayOfMonth, 7, "Sunday is ISO day 7, not day 1 of a new week");
  assert.equal(win.daysInMonth, 7);
  assert.equal(win.start.getDate(), 20, "week started Monday 20 Jul");
  assert.equal(win.start.getHours(), 0, "week starts at midnight");
  assert.equal(win.since(new Date(2026, 6, 20, 0, 0, 0).toISOString()), true, "Monday counts");
  assert.equal(win.since(new Date(2026, 6, 19, 23, 0, 0).toISOString()), false, "prior Sunday does not");
  assert.equal(periodElapsedShare("weekly", sunday), 1, "whole week elapsed by Sunday");

  const monday = new Date(2026, 6, 20, 9, 0, 0);
  assert.equal(periodWindow("weekly", monday).dayOfMonth, 1, "Monday is day 1");
  assert.equal(periodWindow("weekly", monday).start.getDate(), 20);
}
{
  const d = new Date(2026, 6, 23, 18, 0, 0);
  assert.equal(periodWindow("daily", d).daysInMonth, 1);
  assert.equal(periodWindow("daily", d).since(new Date(2026, 6, 23, 0, 0, 0).toISOString()), true);
  const monthly = periodWindow("monthly", d);
  assert.equal(monthly.dayOfMonth, 23);
  assert.equal(monthly.daysInMonth, 31);
  assert.equal(monthly.start.getDate(), 1);
}

// monthToDateWindows: compare like-for-like. The old MoM insight put N days of
// this month against a FULL previous month, so it read as a huge improvement
// every month.
{
  const w = monthToDateWindows(new Date(2026, 6, 23, 20, 0, 0)); // 23 Jul 2026
  assert.equal(w.current.days, 23);
  assert.equal(w.prior.days, 23, "prior window covers the same elapsed days");
  assert.equal(w.comparable, true);
  assert.equal(w.current.start.getMonth(), 6);
  assert.equal(w.current.end.getDate(), 24, "half-open: through end of the 23rd");
  assert.equal(w.prior.start.getMonth(), 5, "previous calendar month");
  assert.equal(w.prior.end.getDate(), 24);
}
{
  // 31 Mar vs a 28-day February: clamp and flag rather than assert a bogus delta.
  const w = monthToDateWindows(new Date(2026, 2, 31, 12, 0, 0));
  assert.equal(w.current.days, 31);
  assert.equal(w.prior.days, 28);
  assert.equal(w.comparable, false);
  assert.equal(w.prior.end.getMonth(), 2, "clamped to 1 Mar (exclusive end)");
  assert.equal(w.prior.end.getDate(), 1);
}
{
  // Day 1 of a month still yields a one-day-vs-one-day comparison, not 1 vs 30.
  const w = monthToDateWindows(new Date(2026, 6, 1, 8, 0, 0));
  assert.equal(w.current.days, 1);
  assert.equal(w.prior.days, 1);
  assert.equal(w.comparable, true);
}

console.log("budget-trajectory tests passed");
