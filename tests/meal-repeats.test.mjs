import assert from "node:assert/strict";
import { normalizeMealKey, slotForHour, topRepeatMeals, topStapleCombos, rowForRepeat } from "../lib/meal-repeats.mjs";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

const NOW = new Date("2026-07-25T13:00:00+05:30"); // lunch time IST
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// ---- normalizeMealKey ----

// The key is FOOD CONTENT, not the sentence: the owner never types a meal the
// same way twice, and a text key made every re-wording a separate meal.
assert.equal(normalizeMealKey("4 boiled eggs"), "egg:4");
assert.equal(normalizeMealKey("  4 Boiled Eggs!  "), "egg:4", "casing and punctuation collapse");
assert.equal(
  normalizeMealKey("6 boiled eggs"),
  normalizeMealKey("6 whole boiled eggs"),
  "wording drift on the SAME food groups - these were two chips for one meal on real data",
);
assert.equal(
  normalizeMealKey("70g soya bean, 50g oats"),
  normalizeMealKey("70 g soya chunks + 50 g oats"),
  "the food table's aliases decide identity, so soya bean and soya chunks group",
);
assert.notEqual(
  normalizeMealKey("4 boiled eggs"),
  normalizeMealKey("6 boiled eggs"),
  "quantities are KEPT - different quantity is a different meal with different macros",
);
assert.notEqual(
  normalizeMealKey("3 egg curry and 2 rotis"),
  normalizeMealKey("3 egg curry and 2 rotis with some raita"),
  "an unrecognised extra food keeps the meals apart rather than silently merging them",
);
// Nothing the table knows -> fall back to the old text key, so meals made of
// foods outside the vocabulary still group as they always did.
assert.equal(normalizeMealKey("mystery meal"), "mystery meal");
assert.equal(normalizeMealKey("  Mystery  Meal! "), "mystery meal");
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
assert.deepEqual(topStapleCombos(null, { now: NOW }), []);
assert.deepEqual(topStapleCombos([null, undefined, {}], { now: NOW }), []);

// ---------------------------------------------------------------------------
// THE SOYA-AND-OATS REGRESSION
//
// These four rows are copied VERBATIM out of the live food_logs table on
// 2026-08-08 (user 548339a8, deleted_at is null). The owner ate soya chunks with
// oats for dinner on three consecutive nights and asked why no suggestion ever
// appeared. It never appeared because the three sentences share no wording and no
// food SET - the accompaniments changed every night - so every meal-level repeat
// detector saw three meals eaten once each.
//
// Do not "tidy" these strings. Their exact messiness is the test.

const REAL_NOW = new Date("2026-08-08T21:00:00+05:30"); // dinner time IST
const realRows = [
  {
    description: "Paneer 200 g, soya chunks 30 g, oats 30 g, peanuts (small handful), homemade sambar (1 serving)",
    meal_slot: "dinner", occurred_at: "2026-08-07T16:33:21.000Z",
    calories_estimate: 1056, protein_g: 68.4, carbs_g: 60, fat_g: 55,
  },
  {
    description: "70g soya bean, 50g oats",
    meal_slot: "dinner", occurred_at: "2026-08-06T16:48:35.000Z",
    calories_estimate: 429, protein_g: 42.7, carbs_g: 57, fat_g: 4,
  },
  {
    description: "70 g soya chunks (soaked in water, drained) + 50 g Saffola tomato oats + puliyogare masala + a few peanuts (quantity unknown), all mixed in water and eaten",
    meal_slot: "dinner", occurred_at: "2026-08-05T17:30:39.115Z",
    calories_estimate: 552, protein_g: 46, carbs_g: 60, fat_g: 12,
  },
  // A one-off from the same window that must NOT become a suggestion.
  {
    description: "120g oats",
    meal_slot: "other", occurred_at: "2026-08-02T17:30:13.000Z",
    calories_estimate: 450, protein_g: 15, carbs_g: 81, fat_g: 9,
  },
];

// Every one of these is its own meal-level group, so the old whole-meal path
// legitimately finds nothing. That is the bug's mechanism, pinned.
assert.equal(
  new Set(realRows.map((r) => normalizeMealKey(r.description))).size,
  4,
  "the three soya dinners really are four distinct meals - grouping whole meals can never see this habit",
);
assert.deepEqual(
  topRepeatMeals(realRows, { now: REAL_NOW, combos: false }),
  [],
  "REGRESSION: whole-meal repeats alone produce nothing for the owner's real soya history",
);

// The combination detector is what sees it.
const realChips = topRepeatMeals(realRows, { now: REAL_NOW, limit: 5 });
const soya = realChips.find((c) => c.foods && c.foods.includes("soya chunks") && c.foods.includes("oats"));
assert.ok(soya, `soya + oats must be suggested, got: ${JSON.stringify(realChips.map((c) => c.label))}`);
assert.equal(soya.kind, "combo");
assert.equal(soya.days, 3, "three distinct days of evidence - 5, 6 and 7 August IST");
assert.equal(soya.slot, "dinner");
assert.equal(soya.label, "70 g soya chunks + 40 g oats", "labelled with the quantities he actually used");

// The macros must be the food table's, not invented, and must survive a
// round-trip through the parser - a chip whose own text does not price back to
// its own numbers is exactly the "absent data asserted as measured" bug.
const repriced = estimateNutrition(soya.label);
assert.ok(repriced.recognized, "a combo chip's label must be fully priceable by the food table");
assert.equal(repriced.totals.calories, soya.calories_estimate, "chip calories == what its own text prices to");
assert.equal(repriced.totals.protein_g, soya.protein_g, "chip protein == what its own text prices to");
// Sanity against reality: his own logged soya-and-oats dinner was 429 kcal / 42.7 g.
assert.ok(Math.abs(soya.calories_estimate - 429) < 120, `combo kcal near his logged dinner, got ${soya.calories_estimate}`);
assert.ok(soya.protein_g > 35, `soya chunks are 52 g protein per 100 g dry, got ${soya.protein_g}`);

// Tapping it writes a row that agrees with itself.
const soyaRow = rowForRepeat(soya, { now: REAL_NOW });
assert.equal(soyaRow.description, "70 g soya chunks + 40 g oats");
assert.equal(soyaRow.calories_estimate, soya.calories_estimate);
assert.equal(soyaRow.meal_slot, "dinner", "21:00 IST is dinner");
assert.equal(soyaRow.confidence, 1);

// Two days is not yet a habit; three is. The owner said "two to three days", and
// three consecutive days is where this fires.
assert.deepEqual(
  topStapleCombos(realRows.slice(0, 2), { now: REAL_NOW }),
  [],
  "two days of evidence is below the threshold",
);
assert.ok(
  topStapleCombos(realRows.slice(0, 2), { now: REAL_NOW, minDays: 2 }).some((c) => c.foods.includes("soya chunks")),
  "the threshold is a knob, and at minDays 2 those same two days do fire",
);

// Eating the same thing twice in ONE day is one day of evidence, not two.
const sameDayTwice = [
  { description: "70g soya bean, 50g oats", meal_slot: "dinner", occurred_at: "2026-08-06T16:48:35.000Z", calories_estimate: 429, protein_g: 42.7 },
  { description: "60 g soya chunks and 40 g oats", meal_slot: "lunch", occurred_at: "2026-08-06T07:10:00.000Z", calories_estimate: 400, protein_g: 38 },
  { description: "70g soya bean, 50g oats", meal_slot: "dinner", occurred_at: "2026-08-05T17:30:39.115Z", calories_estimate: 429, protein_g: 42.7 },
];
assert.deepEqual(
  topStapleCombos(sameDayTwice, { now: REAL_NOW }),
  [],
  "three rows across two days is two days of evidence",
);

// A combination the food table cannot fully price must never be offered - its
// macros would be a guess wearing a measured number's clothes.
const unpriceable = [1, 2, 3].map((n) => ({
  description: "kachori with imli chutney",
  meal_slot: "snack",
  occurred_at: new Date(REAL_NOW.getTime() - n * 86400000).toISOString(),
  calories_estimate: 300,
}));
assert.deepEqual(topStapleCombos(unpriceable, { now: REAL_NOW }), [], "unknown foods cannot become a priced chip");

// A single food is not a combination. On real data this path emitted "3 curd" and
// "2 whey scoop" as chips of their own, restating meals already on the row.
const singles = [1, 2, 3, 4].map((n) => ({
  description: `${n + 2} boiled eggs`,
  meal_slot: "lunch",
  occurred_at: new Date(REAL_NOW.getTime() - n * 86400000).toISOString(),
  calories_estimate: 300,
}));
assert.deepEqual(topStapleCombos(singles, { now: REAL_NOW }), [], "one food on four days is not a combination");

// A combination already covered exactly by a whole-meal chip is not offered twice.
const dupeRows = [1, 2, 3].map((n) => ({
  description: "6 boiled eggs and 200 g paneer",
  meal_slot: "dinner",
  occurred_at: new Date(REAL_NOW.getTime() - n * 86400000).toISOString(),
  calories_estimate: 962, protein_g: 73.8, carbs_g: 9, fat_g: 70,
}));
const dupeChips = topRepeatMeals(dupeRows, { now: REAL_NOW });
assert.equal(dupeChips.length, 1, `the same meal must not appear as both a repeat and a combo: ${JSON.stringify(dupeChips.map((c) => c.label))}`);
assert.equal(dupeChips[0].kind, "repeat", "the verbatim chip wins - its macros are what he was actually served");

console.log("meal-repeats.test.mjs OK");
