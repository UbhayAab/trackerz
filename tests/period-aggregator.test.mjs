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
ok(series.every((p) => "date" in p && "value" in p));

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

console.log(`period-aggregator tests passed: ${n} assertions`);
