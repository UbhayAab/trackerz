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

assert.equal(result.unpricedCount, 0, "both expenses predate the last known close");
assert.equal(result.disclosure, null, "nothing to disclose when every rupee is benchmarked");
assert.equal(result.pricedSpent, result.totalSpent);

const empty = computeOpportunityCost([]);
assert.equal(empty.count, 0);
assert.equal(empty.totalSpent, 0);
assert.equal(empty.gain, 0);
assert.equal(empty.disclosure, null);

// Spend that post-dates the last Nifty close on file has no benchmark to grow
// by. It used to be silently multiplied by 1.0 and folded into the headline as
// if it had been measured; now it is held at cost AND disclosed.
{
  const ref = result.referenceMonth; // e.g. "2026-05"
  const [y, m] = ref.split("-").map(Number);
  const afterRef = new Date(Date.UTC(y, m, 15)).toISOString(); // month after the last close
  const mixed = computeOpportunityCost([
    { direction: "expense", is_discretionary: true, amount: 1000, occurred_at: "2020-04-15T12:00:00Z" },
    { direction: "expense", is_discretionary: true, amount: 400, occurred_at: afterRef },
  ]);
  assert.equal(mixed.count, 2);
  assert.equal(mixed.unpricedCount, 1);
  assert.equal(mixed.unpricedSpent, 400);
  assert.equal(mixed.pricedSpent, 1000);
  assert.equal(mixed.pricedCount, 1);
  assert.ok(mixed.disclosure && mixed.disclosure.includes(ref), "disclosure names the reference month");

  // The unpriced rupees contribute exactly their cost -- no invented growth.
  const pricedOnly = computeOpportunityCost([
    { direction: "expense", is_discretionary: true, amount: 1000, occurred_at: "2020-04-15T12:00:00Z" },
  ]);
  assert.equal(mixed.hypotheticalNow, pricedOnly.hypotheticalNow + 400);
  assert.equal(mixed.gain, pricedOnly.gain, "held-at-cost spend adds zero gain");
  assert.ok(mixed.pct < pricedOnly.pct, "headline % is diluted by held-at-cost spend");
  assert.equal(mixed.pricedPct, pricedOnly.pct, "pricedPct reports the benchmarked return undiluted");
}

console.log("opportunity-cost tests passed");
