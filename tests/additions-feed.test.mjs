import assert from "node:assert/strict";
import { buildAdditions, groupByDay } from "../lib/additions.mjs";

const ledger = [
  { id: "l1", occurred_at: "2026-06-23T15:00:00+05:30", merchant: "Zomato", amount: 240, direction: "expense", duplicate_state: "unique" },
  { id: "l2", occurred_at: "2026-06-22T10:00:00+05:30", merchant: "Salary", amount: 50000, direction: "income", duplicate_state: "unique" },
  { id: "l3", occurred_at: "2026-06-23T15:01:00+05:30", merchant: "dup", amount: 240, direction: "expense", duplicate_state: "duplicate_loser" },
];
const foods = [
  { id: "f1", occurred_at: "2026-06-23T13:00:00+05:30", meal_slot: "lunch", description: "egg curry", calories_estimate: 520, protein_g: 43 },
];

const items = buildAdditions(ledger, foods);

// Rows merged away by dedupe are hidden (they live under their winner).
assert.ok(!items.find((i) => i.id === "l3"), "merged loser excluded");
// Expense is negative, income positive.
assert.match(items.find((i) => i.id === "l1").delta, /-Rs\s?240/);
assert.match(items.find((i) => i.id === "l2").delta, /\+Rs\s?50,000/);
// Food shows calories + protein and is tagged diet.
const f = items.find((i) => i.id === "f1");
assert.ok(f.delta.includes("520 cal") && f.delta.includes("43g P"), "food delta");
assert.equal(f.domain, "diet");
assert.equal(f.table, "food_logs");
// Newest first.
assert.equal(items[0].id, "l1");
// Day-over-day grouping: two days, newest first.
const groups = groupByDay(items);
assert.equal(groups.length, 2);
assert.equal(groups[0].dayKey, "2026-06-23");
assert.equal(groups[0].rows.length, 2);

console.log("additions-feed tests passed");
