import assert from "node:assert/strict";
import { aggregatePeriods, dailySeries } from "../src/analytics/period-aggregator.js";
import { composeInsights } from "../src/analytics/insights-feed.js";

let n = 0;
function eq(a, b, msg) { assert.equal(a, b, msg); n += 1; }
function ok(c, msg) { assert.ok(c, msg); n += 1; }
function close(a, b, eps = 0.001, msg) { assert.ok(Math.abs(a - b) <= eps, msg || `${a} vs ${b}`); n += 1; }

// Anchor at midday local on May 22. Build ISO timestamps from that anchor so
// the test is independent of the runner's timezone.
const today = new Date(2026, 4, 22, 12, 0, 0);
const isoLocal = (year, month, day, hour, min = 0) =>
  new Date(year, month - 1, day, hour, min, 0).toISOString();

const ledger = [
  { amount: 250, direction: "expense", occurred_at: isoLocal(2026, 5, 22, 8) },
  { amount: 100, direction: "expense", occurred_at: isoLocal(2026, 5, 22, 14) },
  { amount: 400, direction: "expense", occurred_at: isoLocal(2026, 5, 21, 20) }, // yesterday
  { amount: 50000, direction: "income", occurred_at: isoLocal(2026, 5, 1, 9) },  // this month
  { amount: 200, direction: "expense", occurred_at: isoLocal(2026, 4, 15, 9) },  // prev month
];

const foodLogs = [
  { calories_estimate: 600, protein_g: 35, occurred_at: isoLocal(2026, 5, 22, 8, 30) },
  { calories_estimate: 800, protein_g: 45, occurred_at: isoLocal(2026, 5, 22, 13, 30) },
];

const wellnessLogs = [
  { mood_score: 7, occurred_at: isoLocal(2026, 5, 22, 22) },
];

const bodyMetrics = [
  { metric_type: "steps", value: 5400, occurred_at: isoLocal(2026, 5, 22, 20) },
  { metric_type: "sleep_hours", value: 7.5, occurred_at: isoLocal(2026, 5, 22, 7) },
];

const agg = aggregatePeriods({ ledger, foodLogs, wellnessLogs, bodyMetrics, today });

// Today
eq(agg.today.spend, 350, "today spend = 250 + 100");
eq(agg.today.mealCount, 2);
eq(agg.today.protein, 80);
eq(agg.today.steps, 5400);
eq(agg.today.sleepHoursAvg, 7.5);

// Yesterday
eq(agg.yesterday.spend, 400);

// Month + delta
ok(agg.month.spend >= 750);
ok(agg.prev_month.spend === 200);
ok(agg.deltas.dod_spend !== undefined);
ok(agg.deltas.mom_spend > 0); // current month > prev month

// Sparkline series shape
const series = dailySeries({ rows: ledger.filter((r) => r.direction === "expense"), today, days: 7, valueOf: (r) => Number(r.amount) });
eq(series.length, 7);
ok(series.every((p) => "date" in p && "value" in p && "measured" in p));

// Insights composition
const insights = composeInsights({ aggregates: agg, budgets: [], subscriptions: [], ledger, today });
ok(insights.length >= 1);
ok(insights.some((i) => i.kind === "money"));

// Protein warning fires when daily protein < 90 with 2+ meals.
const lowProtein = [
  { calories_estimate: 600, protein_g: 20, occurred_at: isoLocal(2026, 5, 22, 8, 30) },
  { calories_estimate: 800, protein_g: 25, occurred_at: isoLocal(2026, 5, 22, 13, 30) },
];
const aggLow = aggregatePeriods({ ledger, foodLogs: lowProtein, wellnessLogs, bodyMetrics, today });
const insightsLow = composeInsights({ aggregates: aggLow, ledger, today });
ok(insightsLow.some((i) => i.kind === "diet"));

// ---- absent is not zero -----------------------------------------------------
//
// The Today tiles used to read "PROTEIN 0g v 100%" and "CALORIES 0 v 89%" on a
// day with no food logged yet, while the line charts three inches below on the
// same page correctly drew a gap. A 100% drop is a claim about a day that has
// not happened. steps and sleepHoursAvg already had this guard; calories,
// protein and their deltas were left out of it.
{
  const yesterdayFood = [
    { calories_estimate: 900, protein_g: 44.8, occurred_at: isoLocal(2026, 5, 21, 13, 0) },
  ];
  const a = aggregatePeriods({ ledger: [], foodLogs: yesterdayFood, wellnessLogs: [], bodyMetrics: [], today });
  eq(a.today.mealCount, 0, "no meals today");
  eq(a.today.protein, null, "protein is null, not a measured 0, when nothing was logged");
  eq(a.today.calories, null, "calories is null, not a measured 0, when nothing was logged");
  eq(a.deltas.dod_protein, null, "no percentage against an unmeasured day");
  eq(a.deltas.dod_calories, null, "no percentage against an unmeasured day");
  // A no-spend day IS a measured fact - you were there and you spent nothing.
  eq(a.today.spend, 0, "spend stays a real 0");

  // With meals logged, real numbers come back.
  const bothDays = yesterdayFood.concat([
    { calories_estimate: 400, protein_g: 30, occurred_at: isoLocal(2026, 5, 22, 9, 0) },
  ]);
  const b = aggregatePeriods({ ledger: [], foodLogs: bothDays, wellnessLogs: [], bodyMetrics: [], today });
  eq(b.today.protein, 30, "a logged day reports its real protein");
  eq(b.today.calories, 400);
  ok(typeof b.deltas.dod_protein === "number", "a real comparison still produces a number");

  // The protein warning must not fire on a day with nothing logged.
  const noFood = composeInsights({ aggregates: a, budgets: [], ledger: [], today });
  ok(!noFood.some((i) => i.kind === "diet" && /Protein at/.test(i.text)), "no protein claim without food rows");
}

// ---- dailySeries: a day with no rows is null, not a measured 0 --------------
//
// This is the line the whole failure-surfacing phase was named after. The
// function used to emit `value: 0` for every day it had no rows for, and those
// zeroes flowed into the trend lines as "you ate nothing" / "you spent nothing"
// on days the user had simply not captured yet - a 30-day chart of a three-day-old
// account drew 27 confident zeroes and there is no way for a reader to tell that
// flat line from real restraint. lib/jarvis-brief.mjs has mandated exactly this
// discipline for briefings since it was written ("NULL MEANS NOT MEASURED...
// Never render null as zero"); the analytics layer was the one place ignoring it.
{
  const rows = [
    { amount: 300, occurred_at: isoLocal(2026, 5, 22, 10) }, // today
    { amount: 0, occurred_at: isoLocal(2026, 5, 20, 10) },   // two days ago, a real 0
  ];
  const s = dailySeries({ rows, today, days: 5, valueOf: (r) => Number(r.amount) });
  eq(s.length, 5);

  const byDate = Object.fromEntries(s.map((p) => [p.date, p]));
  const dayKey = (dayOfMonth) => new Date(2026, 4, dayOfMonth).toISOString().slice(0, 10);

  // Measured, non-zero.
  eq(byDate[dayKey(22)].value, 300);
  eq(byDate[dayKey(22)].measured, true);

  // MEASURED ZERO: a row existed and it summed to zero. That is a fact and it
  // must survive as 0, not be flattened into "no data".
  eq(byDate[dayKey(20)].value, 0, "a row that sums to zero is a measured zero");
  eq(byDate[dayKey(20)].measured, true);

  // ABSENT: no rows at all. null, never 0.
  eq(byDate[dayKey(21)].value, null, "a day with no rows is null, not a measured 0");
  eq(byDate[dayKey(21)].measured, false);
  eq(byDate[dayKey(19)].value, null);
  eq(byDate[dayKey(19)].measured, false);

  // Nothing anywhere in the window: every point is a gap, not a flat zero line.
  const none = dailySeries({ rows: [], today, days: 7, valueOf: (r) => Number(r.amount) });
  ok(none.every((p) => p.value === null && p.measured === false), "an empty series is all gaps, never a flat zero line");

  // A row whose value is unusable (null / "" / NaN) is not a measurement either -
  // it must not flip `measured` on while contributing nothing.
  const junk = dailySeries({
    rows: [{ amount: null, occurred_at: isoLocal(2026, 5, 22, 10) }],
    today, days: 2, valueOf: (r) => r.amount,
  });
  ok(junk.every((p) => p.measured === false), "a row carrying no usable number is not a measurement");
}

// ---- a body metric with no value is not a measured 0 ------------------------
//
// `Number(b.value || 0)` used to increment stepDays/sleepCount for a row whose
// value was null: the "was this measured?" flag flipped on while nothing was
// added, so the tile reported a confident "0 steps" it had never measured.
{
  const a = aggregatePeriods({
    ledger: [], foodLogs: [], wellnessLogs: [],
    bodyMetrics: [{ metric_type: "steps", value: null, occurred_at: isoLocal(2026, 5, 22, 20) }],
    today,
  });
  eq(a.today.steps, null, "a steps row with no value leaves steps unmeasured");

  const b = aggregatePeriods({
    ledger: [], foodLogs: [], wellnessLogs: [],
    bodyMetrics: [{ metric_type: "steps", value: 0, occurred_at: isoLocal(2026, 5, 22, 20) }],
    today,
  });
  eq(b.today.steps, 0, "a steps row that really says 0 is a measured 0 and still renders");
}

// A ledger row with an unusable amount is skipped rather than folded in as a
// measured Rs 0 transaction.
{
  const a = aggregatePeriods({
    ledger: [
      { amount: null, direction: "expense", occurred_at: isoLocal(2026, 5, 22, 9) },
      { amount: 120, direction: "expense", occurred_at: isoLocal(2026, 5, 22, 10) },
    ],
    foodLogs: [], wellnessLogs: [], bodyMetrics: [], today,
  });
  eq(a.today.spend, 120, "an amount-less ledger row contributes nothing instead of a fake Rs 0");
}

console.log(`period-aggregator tests passed: ${n} assertions`);
