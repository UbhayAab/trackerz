import assert from "node:assert/strict";
import { expandToolCalls, looksLikeFood, mealSlotFromTime } from "../lib/fan-out-expander.mjs";

// Food merchant + food word detection.
assert.ok(looksLikeFood("Zomato"));
assert.ok(looksLikeFood("had dinner 3 rotis"));
assert.ok(!looksLikeFood("fuel"));
assert.ok(!looksLikeFood("Amazon order"));

// Meal slot from the timestamp's local hour (TZ-independent).
assert.equal(mealSlotFromTime("2026-06-23T13:00:00+05:30"), "lunch");
assert.equal(mealSlotFromTime("2026-06-23T08:00:00+05:30"), "breakfast");
assert.equal(mealSlotFromTime("2026-06-23T20:30:00+05:30"), "dinner");

// "paid 240 zomato lunch" (only the expense emitted) -> expander adds a food_log.
const zomato = expandToolCalls([
  { name: "create_expense_candidate", arguments: { amount: 240, merchant: "Zomato", description: "lunch", occurred_at: "2026-06-23T13:00:00+05:30" }, confidence: 0.9 },
]);
assert.equal(zomato.length, 2);
const food = zomato.find((t) => t.name === "create_food_log_candidate");
assert.ok(food, "food_log synthesized");
assert.equal(food.arguments.meal_slot, "lunch");
assert.equal(food.arguments.occurred_at, "2026-06-23T13:00:00+05:30");
assert.equal(food.arguments._auto_expanded, true);
assert.ok(food.confidence < 0.9 && food.confidence > 0, "lower confidence than the expense");

// Non-food spend -> no fan-out.
const fuel = expandToolCalls([
  { name: "create_expense_candidate", arguments: { amount: 2000, merchant: "fuel", occurred_at: "2026-06-23T09:00:00+05:30" }, confidence: 0.9 },
]);
assert.equal(fuel.length, 1);

// If the model already emitted a food_log near that time, don't double it.
const both = expandToolCalls([
  { name: "create_expense_candidate", arguments: { amount: 240, merchant: "Zomato", occurred_at: "2026-06-23T13:00:00+05:30" }, confidence: 0.9 },
  { name: "create_food_log_candidate", arguments: { description: "zomato lunch", occurred_at: "2026-06-23T13:01:00+05:30" }, confidence: 0.6 },
]);
assert.equal(both.filter((t) => t.name === "create_food_log_candidate").length, 1);

// Pure-food fallback: brain logged nothing (or only review) but the text is food.
const coffee = expandToolCalls([], { evidence: "had coffee with 5 choc chip cookies", now: "2026-06-24T16:00:00+05:30" });
const cf = coffee.find((t) => t.name === "create_food_log_candidate");
assert.ok(cf, "pure-food fallback logs a food");
assert.equal(cf.arguments.meal_slot, "snack");
assert.ok(cf.arguments.description.includes("coffee"));

// A review-only result for clear food becomes a food log (review dropped).
const fromReview = expandToolCalls(
  [{ name: "request_user_review", arguments: { reason: "domain unclear" }, confidence: 0.5 }],
  { evidence: "ate 3 rotis dal sabzi", now: "2026-06-24T13:30:00+05:30" },
);
assert.ok(fromReview.some((t) => t.name === "create_food_log_candidate"), "food logged");
assert.ok(!fromReview.some((t) => t.name === "request_user_review"), "review dropped once resolved");

// Non-food text with no writes stays untouched (no spurious food log).
const note = expandToolCalls([{ name: "request_user_review", arguments: { reason: "x" }, confidence: 0.5 }], { evidence: "call the bank tomorrow" });
assert.ok(!note.some((t) => t.name === "create_food_log_candidate"), "non-food not logged");

console.log("fan-out-expander tests passed");
