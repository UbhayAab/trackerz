import assert from "node:assert/strict";
import { scorePair, currencyConflict } from "../src/duplicates/score-pair.js";
import { clusterExpenseSubsetSums } from "../src/duplicates/expense-duplicates.js";
import { sameIngestionReapply } from "../src/services/dedupe-scan.js";
import { summarizeSide, pickDefaultKeep, isMerged } from "../src/ui/duplicates-panel.js";

// ---------------------------------------------------------------- currency (c)
const inr = { id: "a", amount: 80, currency: "INR", merchant: "Cafe", direction: "expense", occurred_at: "2026-07-09T13:00:00Z" };
const usd = { id: "b", amount: 80, currency: "USD", merchant: "Cafe", direction: "expense", occurred_at: "2026-07-09T13:00:00Z" };
assert.equal(currencyConflict(inr, usd), true);
const cross = scorePair(inr, usd);
assert.equal(cross.score, 0, "cross-currency rows must never be flagged as duplicates");
assert.deepEqual(cross.reasons, ["currency_mismatch"]);

// Same currency still scores exactly as before.
assert.ok(scorePair(inr, { ...usd, currency: "inr" }).score >= 0.9, "case-insensitive currency match");

// An unknown currency is unknown - it neither blocks nor credits.
assert.equal(currencyConflict(inr, { ...usd, currency: null }), false);
assert.ok(scorePair(inr, { ...usd, currency: null }).score >= 0.9);

// ------------------------------------------------------- same-ingestion re-apply (d)
const base = { amount: 20, direction: "expense", occurred_at: "2026-07-09T13:00:00Z" };
assert.equal(sameIngestionReapply(base, { ...base, occurred_at: "2026-07-09T13:04:00Z" }), true);
// One capture legitimately produces different line items - not duplicates.
assert.equal(sameIngestionReapply(base, { ...base, amount: 60 }), false);
assert.equal(sameIngestionReapply(base, { ...base, direction: "income" }), false);
// Same amount days apart within one ingestion is not a re-application.
assert.equal(sameIngestionReapply(base, { ...base, occurred_at: "2026-07-12T13:00:00Z" }), false);

// ------------------------------------------------------------- subset sum (b)
// The 2026-07-09 incident: one capture applied as Rs 80, then again as 20 + 60.
const incident = [
  { id: "e80", amount: 80, direction: "expense", currency: "INR", description: "lays and boiled eggs", source_type: "audio", occurred_at: "2026-07-09T13:00:00Z" },
  { id: "e20", amount: 20, direction: "expense", currency: "INR", description: "lays", source_type: "audio", occurred_at: "2026-07-09T13:02:00Z" },
  { id: "e60", amount: 60, direction: "expense", currency: "INR", description: "3 boiled eggs", source_type: "audio", occurred_at: "2026-07-09T13:02:00Z" },
];
const groups = clusterExpenseSubsetSums(incident);
assert.equal(groups.length, 1, "Rs 80 = Rs 20 + Rs 60 must produce one group");
assert.equal(groups[0].parent.id, "e80");
assert.deepEqual(groups[0].items.map((i) => i.id).sort(), ["e20", "e60"]);
assert.equal(groups[0].sumAmount, 80);
assert.equal(groups[0].diff, 0);

// The bank-anchored path (merchant + source_type) still routes through the
// previously-unreferenced dedupe-matrix matcher.
const bankCase = clusterExpenseSubsetSums([
  { id: "bank", amount: 280, direction: "expense", merchant: "Zomato", source_type: "bank", occurred_at: "2026-07-09T13:00:00Z" },
  { id: "v1", amount: 250, direction: "expense", merchant: "Zomato", source_type: "audio", occurred_at: "2026-07-09T13:05:00Z" },
  { id: "v2", amount: 30, direction: "expense", merchant: "Zomato", source_type: "audio", occurred_at: "2026-07-09T13:06:00Z" },
]);
assert.equal(bankCase.length, 1);
assert.equal(bankCase[0].reason, "subset_sum_merchant");

// Unrelated spends that happen to add up across currencies must not group.
assert.equal(clusterExpenseSubsetSums([
  { id: "p", amount: 80, direction: "expense", currency: "USD", occurred_at: "2026-07-09T13:00:00Z" },
  { id: "c1", amount: 20, direction: "expense", currency: "INR", occurred_at: "2026-07-09T13:01:00Z" },
  { id: "c2", amount: 60, direction: "expense", currency: "INR", occurred_at: "2026-07-09T13:01:00Z" },
]).length, 0);

// Different days must not group even when the arithmetic works.
assert.equal(clusterExpenseSubsetSums([
  { id: "p", amount: 80, direction: "expense", occurred_at: "2026-07-09T13:00:00Z" },
  { id: "c1", amount: 20, direction: "expense", occurred_at: "2026-07-01T13:00:00Z" },
  { id: "c2", amount: 60, direction: "expense", occurred_at: "2026-07-05T13:00:00Z" },
]).length, 0);

// An income row is not part of an expense's split.
assert.equal(clusterExpenseSubsetSums([
  { id: "p", amount: 80, direction: "expense", occurred_at: "2026-07-09T13:00:00Z" },
  { id: "c1", amount: 20, direction: "income", occurred_at: "2026-07-09T13:01:00Z" },
  { id: "c2", amount: 60, direction: "expense", occurred_at: "2026-07-09T13:01:00Z" },
]).length, 0);

// --------------------------------------------------------------- merge UI (a)
assert.equal(isMerged({ merged_into: "e80" }), true);
assert.equal(isMerged({ duplicate_state: "duplicate_loser" }), true);
assert.equal(isMerged({ duplicate_state: "unique" }), false);
// A merged loser is still rendered (it is kept, not deleted) but labelled.
assert.match(summarizeSide({ amount: 20, description: "lays", occurred_at: "2026-07-09T13:02:00Z", merged_into: "e80" }), /already merged/);
assert.doesNotMatch(summarizeSide({ amount: 20, description: "lays", occurred_at: "2026-07-09T13:02:00Z" }), /already merged/);
// Defaulting to an already-merged survivor would drop both sides.
assert.equal(pickDefaultKeep({
  a: { id: "x", amount: 20, merchant: "Cafe", description: "lays", occurred_at: "2026-07-09T13:00:00Z", merged_into: "e80" },
  b: { id: "y", amount: 20, merchant: null, description: "l", occurred_at: "2026-07-09T13:02:00Z" },
}), "b");

console.log("dedupe-merge tests passed");
