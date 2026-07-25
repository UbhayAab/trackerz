import assert from "node:assert/strict";
import { normalizeMealKey, slotForHour, topRepeatMeals, rowForRepeat } from "../lib/meal-repeats.mjs";

const NOW = new Date("2026-07-25T13:00:00+05:30"); // lunch time IST
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// ---- normalizeMealKey ----

assert.equal(normalizeMealKey("4 boiled eggs"), "4 boiled eggs");
assert.equal(normalizeMealKey("  4 Boiled Eggs!  "), "4 boiled eggs", "casing and punctuation collapse");
assert.equal(
  normalizeMealKey("3 egg curry and 2 rotis with some raita"),
  "3 egg curry 2 rotis raita",
  "filler words are dropped so wording drift still groups",
);
assert.notEqual(
  normalizeMealKey("4 boiled eggs"),
  normalizeMealKey("6 boiled eggs"),
  "quantities are KEPT - different quantity is a different meal with different macros",
);
assert.equal(normalizeMealKey(""), "");
assert.equal(normalizeMealKey(null), "");

// ---- slotForHour ----

assert.equal(slotForHour(8), "breakfast");
assert.equal(slotForHour(13), "lunch");
assert.equal(slotForHour(20), "dinner");
assert.equal(slotForHour(2), "snack");
assert.equal(slotForHour("nope"), null);

// ---- topRepeatMeals: the honesty rule ----

const noMacros = [
  { description: "mystery meal", calories_estimate: null, occurred_at: day(1) },
  { description: "mystery meal", calories_estimate: null, occurred_at: day(2) },
  { description: "mystery meal", calories_estimate: null, occurred_at: day(3) },
];
assert.deepEqual(
  topRepeatMeals(noMacros, { now: NOW }),
  [],
  "a meal with unknown calories must never become a chip - tapping it would write a silent zero",
);

const zeroCal = [
  { description: "zero cal", calories_estimate: 0, occurred_at: day(1) },
  { description: "zero cal", calories_estimate: 0, occurred_at: day(2) },
];
assert.deepEqual(topRepeatMeals(zeroCal, { now: NOW }), [], "0 kcal is treated as unknown, not measured");

// ---- topRepeatMeals: ranking ----

const rows = [
  // eaten 4 times, recently, at lunch
  { description: "3 egg curry and 2 rotis", meal_slot: "lunch", calories_estimate: 460, protein_g: 26, carbs_g: 46, fat_g: 18, occurred_at: day(1) },
  { description: "3 egg curry and 2 rotis", meal_slot: "lunch", calories_estimate: 470, protein_g: 26, carbs_g: 46, fat_g: 18, occurred_at: day(3) },
  { description: "3 egg curry and 2 rotis", meal_slot: "lunch", calories_estimate: 450, protein_g: 25, carbs_g: 45, fat_g: 17, occurred_at: day(6) },
  { description: "3 egg curry and 2 rotis", meal_slot: "lunch", calories_estimate: 460, protein_g: 27, carbs_g: 47, fat_g: 19, occurred_at: day(9) },
  // eaten 3 times but a month ago
  { description: "7 homemade idlis", meal_slot: "dinner", calories_estimate: 380, protein_g: 18, carbs_g: 60, fat_g: 6, occurred_at: day(30) },
  { description: "7 homemade idlis", meal_slot: "dinner", calories_estimate: 380, protein_g: 18, carbs_g: 60, fat_g: 6, occurred_at: day(32) },
  { description: "7 homemade idlis", meal_slot: "dinner", calories_estimate: 380, protein_g: 18, carbs_g: 60, fat_g: 6, occurred_at: day(34) },
  // eaten once - below minCount
  { description: "paneer roll", meal_slot: "snack", calories_estimate: 400, protein_g: 15, carbs_g: 40, fat_g: 18, occurred_at: day(2) },
];

const chips = topRepeatMeals(rows, { now: NOW });
assert.equal(chips.length, 2, "one-off meals are not chips");
assert.equal(chips[0].label, "3 egg curry and 2 rotis", "recent + frequent + matching slot ranks first");
assert.equal(chips[0].count, 4);
assert.equal(chips[0].slot, "lunch");
assert.equal(chips[1].label, "7 homemade idlis");
assert.ok(chips[0].score > chips[1].score, "recency and slot match beat raw count");

// median, not mean: 450/460/460/470 -> 460
assert.equal(chips[0].calories_estimate, 460, "median calories");
assert.equal(chips[0].protein_g, 26, "median protein");

// An outlier must not move the chip.
const withOutlier = rows.concat([
  { description: "3 egg curry and 2 rotis", meal_slot: "lunch", calories_estimate: 30000, protein_g: 900, carbs_g: 900, fat_g: 900, occurred_at: day(2) },
]);
const robust = topRepeatMeals(withOutlier, { now: NOW })[0];
assert.ok(robust.calories_estimate < 600, `median resists a 30000 kcal mis-parse, got ${robust.calories_estimate}`);

// ---- window ----

const stale = [
  { description: "old thing", calories_estimate: 200, occurred_at: day(100) },
  { description: "old thing", calories_estimate: 200, occurred_at: day(120) },
];
assert.deepEqual(topRepeatMeals(stale, { now: NOW }), [], "meals outside the window are dropped");

// ---- limit ----
assert.equal(topRepeatMeals(rows, { now: NOW, limit: 1 }).length, 1);

// ---- rowForRepeat ----

const row = rowForRepeat(chips[0], { now: NOW });
assert.equal(row.description, "3 egg curry and 2 rotis");
assert.equal(row.meal_slot, "lunch");
assert.equal(row.calories_estimate, 460);
assert.equal(row.confidence, 1, "a tapped repeat is asserted by the user, not inferred by a model");
assert.equal(row.occurred_at, NOW.toISOString(), "stamped now, not backdated to the original meal");
assert.ok(
  !("source_type" in row),
  "food_logs has no source_type column - emitting one would make every insert fail",
);
assert.equal(rowForRepeat(null), null);

// A chip with no slot falls back to the slot for the current hour.
const slotless = rowForRepeat({ label: "x", calories_estimate: 1 }, { now: NOW });
assert.equal(slotless.meal_slot, "lunch");

// ---- empty / garbage input ----
assert.deepEqual(topRepeatMeals(null, { now: NOW }), []);
assert.deepEqual(topRepeatMeals([null, undefined, {}], { now: NOW }), []);

console.log("meal-repeats.test.mjs OK");
