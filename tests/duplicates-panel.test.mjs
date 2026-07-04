import assert from "node:assert/strict";
import { summarizeSide, pickDefaultKeep } from "../src/ui/duplicates-panel.js";

// summarizeSide
assert.equal(summarizeSide(null), "(already removed)");
assert.match(
  summarizeSide({ amount: 640, merchant: null, description: "bought curd and paneer", occurred_at: "2026-06-28T07:20:00Z" }),
  /₹640.*bought curd and paneer/,
);
assert.match(
  summarizeSide({ amount: 120, merchant: "Cafe", description: "coffee", occurred_at: null }),
  /₹120.*Cafe/,
);

// pickDefaultKeep: merchant present beats merchant absent.
assert.equal(
  pickDefaultKeep({
    a: { amount: 120, merchant: null, description: "rose milk and mushroom sandwich", occurred_at: "2026-06-28T07:18:28Z" },
    b: { amount: 120, merchant: "Mushroom Sandwich and Rose Milk", description: "Mushroom sandwich and rose milk", occurred_at: "2026-06-28T07:19:41Z" },
  }),
  "b",
);

// pickDefaultKeep: neither has a merchant -> longer description wins.
assert.equal(
  pickDefaultKeep({
    a: { amount: 640, merchant: null, description: "bought curd and paneer", occurred_at: "2026-06-28T07:20:00Z" },
    b: { amount: 641, merchant: null, description: "curd and cheese for the week", occurred_at: "2026-06-28T07:19:49Z" },
  }),
  "b",
);

// pickDefaultKeep: identical on both signals -> earlier one wins.
assert.equal(
  pickDefaultKeep({
    a: { amount: 120, merchant: null, description: "same", occurred_at: "2026-06-28T07:18:28Z" },
    b: { amount: 120, merchant: null, description: "same", occurred_at: "2026-06-28T07:19:41Z" },
  }),
  "a",
);

// pickDefaultKeep: one side already deleted -> keep whichever still exists.
assert.equal(pickDefaultKeep({ a: null, b: { amount: 1, description: "x", occurred_at: "2026-01-01" } }), "b");
assert.equal(pickDefaultKeep({ a: { amount: 1, description: "x", occurred_at: "2026-01-01" }, b: null }), "a");

console.log("duplicates-panel tests passed");
