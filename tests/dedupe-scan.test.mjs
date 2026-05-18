import assert from "node:assert/strict";
import { scorePair } from "../src/duplicates/score-pair.js";

// The motivating case: voice said Rs 250, statement showed Rs 252, same lunch time.
const voice = {
  id: "v1",
  amount: 250,
  merchant: "Cafe",
  direction: "expense",
  occurred_at: "2026-05-18T13:05:00Z",
};
const statement = {
  id: "s1",
  amount: 252,
  merchant: "Cafe Espresso",
  direction: "expense",
  occurred_at: "2026-05-18T13:08:00Z",
};

const r = scorePair(voice, statement);
assert.ok(r.score >= 0.6, `expected duplicate score, got ${r.score} (${r.reasons.join(",")})`);
assert.ok(r.reasons.includes("near_amount") || r.reasons.includes("exact_amount"));
assert.ok(r.reasons.includes("same_minute_window") || r.reasons.includes("same_time_window"));

// Different days, same amount, same merchant → not duplicate.
const sameNotDup = scorePair(
  { id: "a", amount: 250, merchant: "Cafe", direction: "expense", occurred_at: "2026-05-01T13:00:00Z" },
  { id: "b", amount: 250, merchant: "Cafe", direction: "expense", occurred_at: "2026-05-15T13:00:00Z" },
);
assert.ok(sameNotDup.score < 0.6, `same-merchant-different-day should not auto-flag, got ${sameNotDup.score}`);

// Exact identical → very high score.
const exact = scorePair(
  { id: "x1", amount: 1000, merchant: "Zomato", direction: "expense", occurred_at: "2026-05-18T13:00:00Z" },
  { id: "x2", amount: 1000, merchant: "Zomato", direction: "expense", occurred_at: "2026-05-18T13:00:00Z" },
);
assert.ok(exact.score >= 0.9, `exact match should score very high, got ${exact.score}`);
assert.ok(exact.reasons.includes("exact_amount"));

console.log("dedupe-scan tests passed");
