import assert from "node:assert/strict";
import { periodWindow } from "../src/analytics/budget-trajectory.js";
import {
  periodRange, inRange, stepAnchor, containsToday, periodLabel, periodShortLabel,
  ledgerCoverage, sumExpenses,
} from "../lib/money-period.mjs";

const iso = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const range = (period, anchor) => periodRange(periodWindow(period, anchor));

// --- windows -----------------------------------------------------------------
// Wed 22 Jul 2026.
const wed = new Date(2026, 6, 22);

const day = range("daily", wed);
assert.equal(day.start.getDate(), 22);
assert.equal(day.end.getDate(), 23);

// ISO week: Monday 20 Jul .. exclusive Monday 27 Jul.
const week = range("weekly", wed);
assert.equal(week.start.getDay(), 1, "week must start on Monday");
assert.equal(week.start.getDate(), 20);
assert.equal(week.end.getDate(), 27);

// A Sunday still belongs to the week that began the previous Monday.
const sunWeek = range("weekly", new Date(2026, 6, 26));
assert.equal(sunWeek.start.getDate(), 20, "Sunday belongs to the ISO week starting Mon 20");
assert.equal(sunWeek.end.getDate(), 27);

const month = range("monthly", wed);
assert.equal(month.start.getMonth(), 6);
assert.equal(month.start.getDate(), 1);
assert.equal(month.end.getMonth(), 7);
assert.equal(month.end.getDate(), 1);

// February, so the end bound can't be a hardcoded 30/31.
const feb = range("monthly", new Date(2026, 1, 14));
assert.equal(feb.end.getMonth(), 2);
assert.equal(feb.end.getDate(), 1);

// --- membership is half-open -------------------------------------------------
assert.equal(inRange(day, iso(2026, 7, 22, 0)), true);
assert.equal(inRange(day, iso(2026, 7, 22, 23)), true);
assert.equal(inRange(day, iso(2026, 7, 23, 0)), false, "end bound is exclusive");
assert.equal(inRange(day, iso(2026, 7, 21, 23)), false);
assert.equal(inRange(day, null), false);
assert.equal(inRange(day, "not-a-date"), false);

// --- stepping ----------------------------------------------------------------
assert.equal(stepAnchor("daily", wed, -1).getDate(), 21);
assert.equal(stepAnchor("weekly", wed, -1).getDate(), 15);
// Stepping months from a 31st must not spill into the month after.
const mar31 = new Date(2026, 2, 31);
const back = stepAnchor("monthly", mar31, -1);
assert.equal(back.getMonth(), 1, "31 Mar minus one month is February, not March");
assert.equal(range("monthly", back).start.getMonth(), 1);

assert.equal(containsToday(range("daily", wed), wed), true);
assert.equal(containsToday(range("daily", stepAnchor("daily", wed, -1)), wed), false);
assert.equal(containsToday(range("monthly", wed), wed), true);

// --- labels ------------------------------------------------------------------
assert.equal(periodLabel("daily", range("daily", wed), wed), "Today · Wed 22 Jul");
assert.equal(periodLabel("daily", range("daily", new Date(2026, 6, 21)), wed), "Tue 21 Jul");
assert.equal(periodLabel("weekly", range("weekly", wed), wed), "This week · 20 - 26 Jul");
assert.equal(periodLabel("weekly", range("weekly", new Date(2026, 6, 15)), wed), "13 - 19 Jul");
assert.equal(periodLabel("monthly", range("monthly", wed), wed), "This month · July 2026");
assert.equal(periodLabel("monthly", range("monthly", new Date(2025, 11, 5)), wed), "December 2025");
// A week straddling a month boundary names both months.
assert.equal(periodLabel("weekly", range("weekly", new Date(2026, 6, 30)), wed), "27 Jul - 2 Aug");
assert.equal(periodShortLabel("monthly", range("monthly", wed), wed), "this month");
assert.equal(periodShortLabel("daily", range("daily", new Date(2026, 6, 4)), wed), "4 Jul");

// --- coverage: the anti-fabrication guard ------------------------------------
const rows = [
  { direction: "expense", amount: 110, occurred_at: iso(2026, 7, 22) },
  { direction: "expense", amount: 110, occurred_at: iso(2026, 7, 21) },
  { direction: "income", amount: 5000, occurred_at: iso(2026, 7, 21) },
  { direction: "expense", amount: 240, occurred_at: iso(2026, 7, 10) },
];

// Under the cap: the query returned everything, so any window is fully known.
assert.equal(ledgerCoverage(rows, range("monthly", new Date(2026, 2, 5)), { limit: 500 }), "full");
// At the cap, the oldest held row is 10 Jul: July is only partly covered...
assert.equal(ledgerCoverage(rows, range("monthly", wed), { limit: 4 }), "partial");
// ...and March is not covered at all - this must never sum to Rs 0.
assert.equal(ledgerCoverage(rows, range("monthly", new Date(2026, 2, 5)), { limit: 4 }), "none");
// A window entirely after the oldest held row is fully covered even at the cap.
assert.equal(ledgerCoverage(rows, range("daily", wed), { limit: 4 }), "full");
assert.equal(ledgerCoverage(null, range("daily", wed), { limit: 4 }), "unknown");
assert.equal(ledgerCoverage(undefined, range("daily", wed), { limit: 4 }), "unknown");

// --- sums --------------------------------------------------------------------
// The user's real recurring lunch: Rs 110 around midday.
assert.deepEqual(sumExpenses(rows, range("daily", wed)), { total: 110, count: 1 });
assert.deepEqual(sumExpenses(rows, range("weekly", wed)), { total: 220, count: 2 }, "income is not spend");
assert.deepEqual(sumExpenses(rows, range("monthly", wed)), { total: 460, count: 3 });
// An empty period is a real measured zero - the caller decides how to word it,
// but count 0 is what lets it say "nothing spent" instead of printing Rs 0.
assert.deepEqual(sumExpenses(rows, range("daily", new Date(2026, 6, 19))), { total: 0, count: 0 });
assert.deepEqual(sumExpenses([], range("daily", wed)), { total: 0, count: 0 });

console.log("money period tests passed");
