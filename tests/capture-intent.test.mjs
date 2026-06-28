import assert from "node:assert/strict";
import {
  classifyConsumption,
  classifyDomains,
  looksLikeGym,
  parseExercises,
  CONSUME_WORDS,
  BUY_WORDS,
  GROCERY_WORDS,
  PLAN_WORDS,
  USUAL_WORDS,
  GYM_WORDS,
  CARDIO_WORDS,
  MEAL_SLOT_WORDS,
  SUPPLEMENT_WORDS,
  WELLNESS_WORDS,
  SET_REP_RE,
  WEIGHT_RE,
} from "../lib/capture-intent.mjs";

// ---------------------------------------------------------------------------
// exported lexicons + regexes — one source of truth shared with the index.ts mirror
// ---------------------------------------------------------------------------
for (const [name, lex] of Object.entries({
  CONSUME_WORDS, BUY_WORDS, GROCERY_WORDS, PLAN_WORDS, USUAL_WORDS,
  GYM_WORDS, CARDIO_WORDS, MEAL_SLOT_WORDS, SUPPLEMENT_WORDS, WELLNESS_WORDS,
})) {
  assert.ok(Array.isArray(lex) && lex.length > 0, `${name} is a non-empty array`);
  assert.ok(lex.every((w) => typeof w === "string"), `${name} is all strings`);
}
assert.ok(SET_REP_RE instanceof RegExp);
assert.ok(WEIGHT_RE instanceof RegExp);
assert.ok(CONSUME_WORDS.includes("ate") && CONSUME_WORDS.includes("had"));
assert.ok(BUY_WORDS.includes("bought") && GROCERY_WORDS.includes("groceries"));

// ---------------------------------------------------------------------------
// classifyConsumption — the core eat-vs-buy-vs-plan split
// ---------------------------------------------------------------------------

// CORE FIX: groceries / stock / "for the week" / quantities -> 'bought', NOT 'ate'.
assert.equal(classifyConsumption("bought 6 eggs and a loaf for the week from Blinkit - 400"), "bought");
assert.equal(classifyConsumption("grocery run at the bakery - 1200"), "bought");
assert.equal(classifyConsumption("picked up 2kg paneer and milk"), "bought");
assert.equal(classifyConsumption("restocked the fridge"), "bought");
assert.equal(classifyConsumption("stocked up on protein bars"), "bought");

// CONSUMED -> 'ate'.
assert.equal(classifyConsumption("had dal and 2 rotis"), "ate");
assert.equal(classifyConsumption("had 3 rotis and dal for lunch"), "ate");
assert.equal(classifyConsumption("ate a sandwich"), "ate");
assert.equal(classifyConsumption("just had coffee and 2 cookies"), "ate");
assert.equal(classifyConsumption("drank a protein shake"), "ate");

// A meal frame (no buy/plan cue) is a consumption.
assert.equal(classifyConsumption("egg curry for lunch"), "ate");

// Tie-break: an explicit eat verb beats a buy word.
assert.equal(classifyConsumption("bought a sandwich and ate it"), "ate");

// 'ordered' alone (no eat verb) -> bought; 'ordered in' -> ate.
assert.equal(classifyConsumption("ordered a cake for the party"), "bought");
assert.equal(classifyConsumption("ordered in pizza tonight"), "ate");

// PLAN / template / target / "my usual".
assert.equal(classifyConsumption("tomorrow I will have oats for breakfast"), "plan");
assert.equal(classifyConsumption("my plan is oats and eggs"), "plan");
assert.equal(classifyConsumption("set my target to 1800 kcal"), "plan");
assert.equal(classifyConsumption("did my usual"), "plan");
assert.equal(classifyConsumption("stuck to the plan today"), "plan");

// Ambiguous / negated food word -> 'none' (must NOT read as 'ate').
assert.equal(classifyConsumption("thinking about pizza"), "none");
assert.equal(classifyConsumption("out of milk"), "none");
assert.equal(classifyConsumption("no time for lunch"), "none");
assert.equal(classifyConsumption("skipped breakfast"), "none");

// Non-food / empty -> 'none'.
assert.equal(classifyConsumption(""), "none");
assert.equal(classifyConsumption("   "), "none");
assert.equal(classifyConsumption("asdf qwer zxcv"), "none");
assert.equal(classifyConsumption("call the bank tomorrow"), "none");

// ---------------------------------------------------------------------------
// classifyDomains — bought food is money-only, eaten food is diet (+ money if paid)
// ---------------------------------------------------------------------------

// THE core regression guard: groceries route to money, NOT diet.
assert.deepEqual(classifyDomains("bought 6 eggs and a loaf for the week from Blinkit - 400"), ["money"]);
assert.deepEqual(classifyDomains("grocery run at the bakery - 1200"), ["money"]);
assert.deepEqual(classifyDomains("ordered a cake for the party"), ["money"]);

// Eaten food -> diet.
assert.deepEqual(classifyDomains("had 3 rotis and dal for lunch"), ["diet"]);

// Restaurant meal that was paid for AND eaten -> both money + diet.
assert.deepEqual(classifyDomains("spent 250 on lunch"), ["money", "diet"]);

// Supplement purchase -> money only (not diet — protein powder isn't "food eaten").
assert.deepEqual(classifyDomains("bought protein powder - 2000"), ["money"]);

// Gym.
assert.deepEqual(classifyDomains("I just did Workout A"), ["gym"]);
assert.deepEqual(classifyDomains("bench 3x10 60kg"), ["gym"]);
assert.deepEqual(classifyDomains("ran 5k this morning"), ["gym"]);

// Wellness.
assert.deepEqual(classifyDomains("slept 7 hours, mood is good"), ["wellness"]);

// De-dupe + stable order ['money','diet','gym','wellness'].
const allDom = classifyDomains("spent 250 on lunch, then ran 5k, slept badly");
assert.deepEqual(allDom, ["money", "diet", "gym", "wellness"]);
assert.equal(new Set(allDom).size, allDom.length, "no duplicate domains");

// Empty / garbage -> [].
assert.deepEqual(classifyDomains(""), []);
assert.deepEqual(classifyDomains("asdf qwer"), []);

// ---------------------------------------------------------------------------
// looksLikeGym — workout free text, even without the word "gym"
// ---------------------------------------------------------------------------
assert.ok(looksLikeGym("I just did Workout A"));
assert.ok(looksLikeGym("did legs"));
assert.ok(looksLikeGym("bench 3x10 60kg"));
assert.ok(looksLikeGym("squat 60kg 3x8"));
assert.ok(looksLikeGym("3x12"), "bare set×rep pattern is a workout");
assert.ok(looksLikeGym("ran 5k"));
assert.ok(looksLikeGym("walked 35 min"));
assert.ok(looksLikeGym("10k steps today"));
assert.ok(!looksLikeGym(""));
assert.ok(!looksLikeGym("had dal and rotis"));
assert.ok(!looksLikeGym("grocery run at the bakery"), "grocery run is not cardio");
assert.ok(!looksLikeGym("need to run an errand"), "errand run is not cardio");

// ---------------------------------------------------------------------------
// parseExercises — best-effort set×rep×weight, never invents reps/sets
// ---------------------------------------------------------------------------

// "name S×R W kg".
assert.deepEqual(parseExercises("bench 3x10 60kg"), [
  { exercise: "bench", sets: 3, reps: 10, weight_kg: 60 },
]);

// "name W kg S×R".
assert.deepEqual(parseExercises("squat 60kg 3x8"), [
  { exercise: "squat", sets: 3, reps: 8, weight_kg: 60 },
]);

// Multiple clauses split on "then" / "," -> two exercises, weights preserved.
assert.deepEqual(parseExercises("squat 60kg 3x8, then leg press 2x12"), [
  { exercise: "squat", sets: 3, reps: 8, weight_kg: 60 },
  { exercise: "leg press", sets: 2, reps: 12, weight_kg: null },
]);

// Reps-in-seconds ("plank 3x30s") still parses (reps:30, no weight).
assert.deepEqual(parseExercises("plank 3x30s"), [
  { exercise: "plank", sets: 3, reps: 30, weight_kg: null },
]);

// Strips a leading verb.
assert.deepEqual(parseExercises("did deadlift 5x5 100kg"), [
  { exercise: "deadlift", sets: 5, reps: 5, weight_kg: 100 },
]);

// Unicode × works too.
assert.deepEqual(parseExercises("ohp 3×12 30kg"), [
  { exercise: "ohp", sets: 3, reps: 12, weight_kg: 30 },
]);

// Label-only workout ("Workout A", "ran 5k") -> no structured sets, [].
assert.deepEqual(parseExercises("I just did Workout A"), []);
assert.deepEqual(parseExercises("ran 5k"), []);
assert.deepEqual(parseExercises("walked 35 min"), []);
assert.deepEqual(parseExercises(""), []);

// ---------------------------------------------------------------------------
// Regression guards for the 3 bugs the adversarial harden phase caught
// ---------------------------------------------------------------------------
// 1. spend + food with no grocery cue = a meal eaten out (the flagship case).
assert.equal(classifyConsumption("spent 120 for mushroom sandwich and rose milk"), "ate");
assert.deepEqual(classifyDomains("spent 120 for mushroom sandwich and rose milk"), ["money", "diet"]);
// 2. a delivery order of a meal is eating, not a grocery purchase.
assert.equal(classifyConsumption("ordered lunch from swiggy 250"), "ate");
assert.deepEqual(classifyDomains("ordered lunch from swiggy 250"), ["money", "diet"]);
// 3. a shopping-list / not-yet-bought intent is NOT a completed purchase.
assert.equal(classifyConsumption("need to buy eggs"), "none");
assert.equal(classifyConsumption("low on milk"), "none");

console.log("capture-intent tests passed");
