import assert from "node:assert/strict";
import { computeOpportunityCost } from "../src/analytics/opportunity-cost.js";

const ledger = [
  { direction: "expense", is_discretionary: true,  amount: 1000, occurred_at: "2020-04-15T12:00:00Z" },
  { direction: "expense", is_discretionary: false, amount: 5000, occurred_at: "2020-04-15T12:00:00Z" },
  { direction: "income",  is_discretionary: true,  amount: 9000, occurred_at: "2020-04-15T12:00:00Z" },
  { direction: "expense", is_discretionary: true,  amount: 500,  occurred_at: "2024-01-10T12:00:00Z" },
];

const result = computeOpportunityCost(ledger);

assert.equal(result.count, 2, "should count only discretionary expenses");
assert.equal(result.totalSpent, 1500);
assert.ok(result.hypotheticalNow > result.totalSpent, "Nifty has risen; hypothetical > spent");
assert.ok(result.gain > 0);
assert.ok(typeof result.pct === "number");
assert.ok(typeof result.referenceMonth === "string");

const empty = computeOpportunityCost([]);
assert.equal(empty.count, 0);
assert.equal(empty.totalSpent, 0);
assert.equal(empty.gain, 0);

console.log("opportunity-cost tests passed");
