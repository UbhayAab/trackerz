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
// Anchor the money fixtures to months the Nifty series actually covers, and do
// the month arithmetic on the 1st. Two bugs this avoids, both of which used to
// make the run fail on a calendar date rather than on a code change:
//   - `new Date(jul 31).setMonth(-3)` is April 31, which JS normalises to May 1,
//     so "3 months ago" and "2 months ago" collapsed onto the same month.
//   - once wall-clock time passed the last close in NIFTY_MONTHLY_CLOSES, every
//     fixture row landed in the unpriced tail, gain rounded to 0, and the
//     opportunity-cost insight was correctly suppressed.
import { NIFTY_MONTHLY_CLOSES } from "../src/data/nifty-monthly-closes.js";
const NIFTY_MONTHS = Object.keys(NIFTY_MONTHLY_CLOSES).sort();
const monthsBeforeLastClose = (back) => {
  const key = NIFTY_MONTHS[NIFTY_MONTHS.length - 1 - back];
  assert.ok(key, `nifty series needs at least ${back + 1} months`);
  return new Date(`${key}-10T12:00:00.000Z`).toISOString();
};

// Today's meals: 40g protein → a clear gap to the 130g target.
const foodLogs = [
  { protein_g: 20, calories_estimate: 500, occurred_at: daysAgoIso(0, 9) },
  { protein_g: 20, calories_estimate: 600, occurred_at: daysAgoIso(0, 13) },
];

// Discretionary spend across several priced months → opportunity cost fires.
const ledger = [
  { id: "a", direction: "expense", is_discretionary: true, amount: 1000, merchant: "Zomato", occurred_at: monthsBeforeLastClose(3) },
  { id: "b", direction: "expense", is_discretionary: true, amount: 1200, merchant: "Swiggy", occurred_at: monthsBeforeLastClose(2) },
  { id: "c", direction: "expense", is_discretionary: true, amount: 800, merchant: "Amazon", occurred_at: monthsBeforeLastClose(1) },
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
