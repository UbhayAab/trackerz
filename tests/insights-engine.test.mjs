// Verifies the insight engine actually fans out across the detectors that were
// previously dead code (protein gap, sleep debt, opportunity cost, etc.).
import assert from "node:assert/strict";
import { buildInsightFeed } from "../src/analytics/insights-engine.js";

const now = new Date();
const daysAgoIso = (daysAgo, h = 12) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};
const monthsAgoIso = (months) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  d.setDate(10);
  return d.toISOString();
};

// Today's meals: 40g protein → a clear gap to the 130g target.
const foodLogs = [
  { protein_g: 20, calories_estimate: 500, occurred_at: daysAgoIso(0, 9) },
  { protein_g: 20, calories_estimate: 600, occurred_at: daysAgoIso(0, 13) },
];

// Discretionary spend across several months → opportunity cost fires.
const ledger = [
  { id: "a", direction: "expense", is_discretionary: true, amount: 1000, merchant: "Zomato", occurred_at: monthsAgoIso(3) },
  { id: "b", direction: "expense", is_discretionary: true, amount: 1200, merchant: "Swiggy", occurred_at: monthsAgoIso(2) },
  { id: "c", direction: "expense", is_discretionary: true, amount: 800, merchant: "Amazon", occurred_at: monthsAgoIso(1) },
];

// Seven nights of short sleep → sleep debt.
const bodyMetrics = [];
for (let i = 0; i < 7; i++) bodyMetrics.push({ metric_type: "sleep_hours", value: 5.5, occurred_at: daysAgoIso(i, 23) });

const feed = buildInsightFeed({ ledger, foodLogs, bodyMetrics });

assert.ok(Array.isArray(feed.lines) && feed.lines.length > 0, "expected a non-empty insight feed");
assert.ok(feed.lines.every((l) => typeof l === "string"), "lines must be strings for the list renderer");
assert.ok(feed.lines.some((l) => /protein gap/i.test(l)), "expected a protein gap insight");
assert.ok(feed.lines.some((l) => /nifty/i.test(l)), "expected an opportunity-cost insight");
assert.ok(feed.lines.some((l) => /sleep debt/i.test(l)), "expected a sleep debt insight");
assert.ok(feed.items.every((it) => it.kind && it.severity && typeof it.text === "string"), "items carry kind+severity");

// Empty input must not throw, must return string lines, and must not surface a
// meaningless zero-vs-zero month delta.
const empty = buildInsightFeed({});
assert.ok(Array.isArray(empty.lines) && empty.lines.every((l) => typeof l === "string"));
assert.ok(!empty.lines.some((l) => /₹0 vs ₹0/.test(l)), "should not emit zero-vs-zero month noise");

console.log(`insights-engine tests passed: ${feed.lines.length} insights composed`);
