import assert from "node:assert/strict";
import { classifyDuplicatePair, clusterByPossibleSum } from "../src/duplicates/dedupe-matrix.js";

let n = 0;
function eq(a, b, msg) { assert.equal(a, b, msg); n += 1; }
function ok(c, msg) { assert.ok(c, msg); n += 1; }

// 1. Hard ref match always wins.
{
  const a = { upi_ref: "ABC123", amount: 250, direction: "expense", merchant: "Zomato",  occurred_at: "2026-05-22T12:30:00Z", source_type: "image" };
  const b = { upi_ref: "ABC123", amount: 250, direction: "expense", merchant: "ZOMATO ONLINE", occurred_at: "2026-05-23T01:00:00Z", source_type: "file" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "merge", "hard ref merges");
  ok(r.reasons.includes("hard_ref_match"));
}

// 2. Voice ~250 + bank ~252 same window → link, not merge.
{
  const a = { amount: 250, direction: "expense", merchant: "Zomato", occurred_at: "2026-05-22T12:30:00Z", source_type: "audio" };
  const b = { amount: 252, direction: "expense", merchant: "ZOMATO LTD", occurred_at: "2026-05-22T13:00:00Z", source_type: "file" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "link");
  ok(r.reasons.includes("voice_vs_bank"));
}

// 3. Same merchant same amount on different days → ignore (recurring).
{
  const a = { amount: 199, direction: "expense", merchant: "Netflix", occurred_at: "2026-05-01T00:00:00Z" };
  const b = { amount: 199, direction: "expense", merchant: "Netflix", occurred_at: "2026-06-01T00:00:00Z" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "ignore");
  ok(r.reasons.includes("recurring_expense"));
}

// 4. Refund pair (opposite directions, same merchant, similar amount).
{
  const a = { amount: 500, direction: "expense", merchant: "Amazon", occurred_at: "2026-05-10T12:00:00Z" };
  const b = { amount: 500, direction: "income", merchant: "Amazon Refund", occurred_at: "2026-05-12T08:00:00Z" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "link");
  eq(r.linkKind, "refund");
}

// 5. Internal transfer (different accounts, opposite directions, same amount, near time).
{
  const a = { amount: 5000, direction: "expense", merchant: "Self transfer", occurred_at: "2026-05-22T10:00:00Z", account: "HDFC-1234", description: "IMPS to ICICI" };
  const b = { amount: 5000, direction: "income",  merchant: "Self transfer", occurred_at: "2026-05-22T10:05:00Z", account: "ICICI-5678", description: "IMPS from HDFC" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "link");
  eq(r.linkKind, "transfer");
}

// 6. Identical event within an hour → merge.
{
  const a = { amount: 480, direction: "expense", merchant: "Swiggy", occurred_at: "2026-05-22T19:31:00Z", source_type: "image" };
  const b = { amount: 480, direction: "expense", merchant: "Swiggy", occurred_at: "2026-05-22T19:50:00Z", source_type: "file" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "merge");
  // bank wins as canonical over image.
  eq(r.canonical, b);
}

// 7. Different merchants → no signal.
{
  const a = { amount: 200, direction: "expense", merchant: "Uber",   occurred_at: "2026-05-22T11:00:00Z" };
  const b = { amount: 200, direction: "expense", merchant: "Zomato", occurred_at: "2026-05-22T11:15:00Z" };
  const r = classifyDuplicatePair(a, b);
  eq(r.verdict, "ignore");
}

// 8. Sum-of-items cluster: voice 250 + 30 ≈ bank 280.
{
  const rows = [
    { id: "p", amount: 280, direction: "expense", merchant: "Zomato", occurred_at: "2026-05-22T13:00:00Z", source_type: "file" },
    { id: "c1", amount: 250, direction: "expense", merchant: "Zomato", occurred_at: "2026-05-22T12:30:00Z", source_type: "audio" },
    { id: "c2", amount: 30,  direction: "expense", merchant: "Zomato", occurred_at: "2026-05-22T12:35:00Z", source_type: "audio" },
  ];
  const groups = clusterByPossibleSum(rows);
  ok(groups.length >= 1);
  ok(groups[0].items.length === 2);
  ok(Math.abs(groups[0].sumAmount - 280) <= 5);
}

console.log(`dedupe-matrix tests passed: ${n} assertions`);
