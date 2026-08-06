// One-shot plan edits: applyDietDelta / applyGymDelta / foldPlanPayloads.
//
// Every delta op now returns { plan, applied, matched_count, reason } instead of a
// bare document, because the three most dangerous things this module used to do
// were all SILENT: a one-character match deleted a meal, an ambiguous match
// deleted the first one it found, and a replace that matched nothing appended.
import assert from "node:assert/strict";
import {
  isPlanDelta, applyDietDelta, applyGymDelta, applyPlanDelta,
  foldPlanPayloads, foldPlanPayloadsDetailed, matchesMeal, sumMeals, MIN_MATCH_LENGTH,
} from "../lib/plan-merge.mjs";

const dietBase = () => ({
  meals: [
    { name: "Shake", slot: "breakfast", calories: 300, protein_g: 30, carbs_g: 10, fat_g: 5 },
    { name: "Lunch bowl", slot: "lunch", calories: 500, protein_g: 40, carbs_g: 50, fat_g: 15 },
  ],
  targets: { calories: 800, protein_g: 70, carbs_g: 60, fat_g: 20, fiber_g: 47, water_ml: 3450 },
});
const gymBase = () => ({ name: "Workout A", kind: "gym", duration_min: 50, items: ["Leg press 2×12", "Bench 2×10"], rules: "no PR" });

// ---- isPlanDelta ----
assert.equal(isPlanDelta({ op: "add_meal" }), true);
assert.equal(isPlanDelta({ meals: [] }), false);
assert.equal(isPlanDelta({}), false);
assert.equal(isPlanDelta(null), false);
assert.equal(isPlanDelta([]), false);
assert.equal(isPlanDelta("op"), false);
assert.equal(isPlanDelta({ op: 5 }), false, "op must be a string");

// ---- applyDietDelta: add_meal ----
{
  const out = applyDietDelta(dietBase(), { op: "add_meal", meal: { name: "Salad bowl", slot: "snack", time: "16:00", calories: 200, protein_g: 10, carbs_g: 20, fat_g: 8 } });
  assert.equal(out.applied, true);
  assert.equal(out.matched_count, 1);
  assert.equal(out.plan.meals.length, 3);
  assert.equal(out.plan.meals[2].name, "Salad bowl");
  assert.equal(out.plan.meals[2].time, "16:00");
  // TARGETS DO NOT MOVE. They used to be recomputed from the surviving meal sum,
  // which meant one delta silently rewrote the goal the app measures against -
  // and an empty meal list produced a 0 kcal target that rendered as a measured
  // zero. A target is a goal; a meal list is a plan.
  assert.deepEqual(out.plan.targets, dietBase().targets, "adding a meal does not move the target");
  // The sum is still available to anyone who wants it - it is just not the target.
  assert.equal(sumMeals(out.plan.meals).calories, 1000);
}

// add_meal normalizes a bad slot + missing macros
{
  const out = applyDietDelta(dietBase(), { op: "add_meal", meal: { name: "Mystery", slot: "brunch" } });
  const added = out.plan.meals[2];
  assert.equal(added.slot, "other", "invalid slot -> other");
  assert.equal(added.calories, 0);
  assert.equal(added.protein_g, 0);
}

// add_meal accepts food-log field aliases (meal_name/description/calories_estimate)
{
  const out = applyDietDelta(dietBase(), { op: "add_meal", meal: { meal_name: "Curd", description: "200g curd", calories_estimate: 120, protein_g: 11 } });
  assert.equal(out.plan.meals[2].name, "Curd");
  assert.equal(out.plan.meals[2].detail, "200g curd");
  assert.equal(out.plan.meals[2].calories, 120);
}

// ---- matchesMeal: the guard that used to not exist ----
// `{op:"remove_meal", match:"e"}` matched nearly EVERY meal, because the match was
// an unanchored substring with no minimum length.
{
  const shake = { name: "Shake", slot: "breakfast", detail: "" };
  assert.equal(matchesMeal(shake, "e"), false, "a one-character match identifies nothing");
  assert.equal(matchesMeal(shake, "ak"), false, "below MIN_MATCH_LENGTH");
  assert.equal(MIN_MATCH_LENGTH, 3);
  assert.equal(matchesMeal(shake, "shake"), true);
  assert.equal(matchesMeal(shake, "SHAKE"), true, "case-insensitive");
  // Word boundaries: "hak" is inside "Shake" but is not a word in it.
  assert.equal(matchesMeal(shake, "hak"), false, "substring inside a word is not a match");
  assert.equal(matchesMeal({ name: "Goat curry", slot: "lunch", detail: "" }, "oat"), false, "'oat' must not match 'goat'");
  assert.equal(matchesMeal({ name: "Oats bowl", slot: "breakfast", detail: "" }, "oats"), true);
  // Slots still match exactly.
  assert.equal(matchesMeal(shake, "breakfast"), true);
  assert.equal(matchesMeal(shake, "dinner"), false);
}

// A one-character match is refused outright rather than deleting something.
{
  const out = applyDietDelta(dietBase(), { op: "remove_meal", match: "e" });
  assert.equal(out.applied, false);
  assert.equal(out.reason, "match_too_short");
  assert.equal(out.plan.meals.length, 2, "nothing was removed");
}

// ---- remove_meal ----
{
  const miss = applyDietDelta(dietBase(), { op: "remove_meal", match: "banana" });
  assert.equal(miss.applied, false);
  assert.equal(miss.matched_count, 0);
  assert.equal(miss.reason, "no_match");
  assert.equal(miss.plan.meals.length, 2, "no match -> no-op");
}
{
  const bySlot = applyDietDelta(dietBase(), { op: "remove_meal", match: "lunch" });
  assert.equal(bySlot.applied, true);
  assert.equal(bySlot.plan.meals.length, 1);
  assert.equal(bySlot.plan.meals[0].name, "Shake");
  assert.deepEqual(bySlot.plan.targets, dietBase().targets, "removing a meal does not shrink the target");
}
{
  const byName = applyDietDelta(dietBase(), { op: "remove_meal", match: "BOWL" });
  assert.equal(byName.applied, true);
  assert.equal(byName.plan.meals.length, 1, "name word match is case-insensitive");
  assert.equal(byName.plan.meals[0].name, "Shake");
}
// AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. Two meals both called "bowl" is the
// user needing to be asked, not the app picking the first one.
{
  const two = {
    meals: [
      { name: "Lunch bowl", slot: "lunch", calories: 500 },
      { name: "Salad bowl", slot: "snack", calories: 200 },
    ],
    targets: { calories: 700 },
  };
  const out = applyDietDelta(two, { op: "remove_meal", match: "bowl" });
  assert.equal(out.applied, false);
  assert.equal(out.matched_count, 2);
  assert.equal(out.reason, "ambiguous_match");
  assert.deepEqual(out.candidates, ["Lunch bowl", "Salad bowl"], "the UI gets both names to offer");
  assert.equal(out.plan.meals.length, 2, "nothing removed while it is ambiguous");
}

// ---- replace_meal ----
{
  const hit = applyDietDelta(dietBase(), { op: "replace_meal", match: "lunch", meal: { name: "Paneer wrap", slot: "lunch", calories: 600, protein_g: 45 } });
  assert.equal(hit.applied, true);
  assert.equal(hit.plan.meals.length, 2);
  assert.equal(hit.plan.meals[1].name, "Paneer wrap");
  assert.deepEqual(hit.plan.targets, dietBase().targets);
}
{
  // Used to APPEND, which grew the plan by one dinner on every retry.
  const miss = applyDietDelta(dietBase(), { op: "replace_meal", match: "dinner", meal: { name: "New dinner", slot: "dinner", calories: 400 } });
  assert.equal(miss.applied, false);
  assert.equal(miss.matched_count, 0);
  assert.equal(miss.reason, "no_match");
  assert.equal(miss.plan.meals.length, 2, "no match -> NOT appended");
}
{
  const two = { meals: [{ name: "Lunch bowl", slot: "lunch" }, { name: "Salad bowl", slot: "snack" }], targets: {} };
  const out = applyDietDelta(two, { op: "replace_meal", match: "bowl", meal: { name: "Wrap" } });
  assert.equal(out.applied, false);
  assert.equal(out.reason, "ambiguous_match");
  assert.equal(out.matched_count, 2);
}

// ---- set_targets: the ONLY op that may move a target ----
{
  const out = applyDietDelta(dietBase(), { op: "set_targets", targets: { calories: 2500, protein_g: 200 } });
  assert.equal(out.applied, true);
  assert.equal(out.plan.meals.length, 2, "meals untouched");
  assert.equal(out.plan.targets.calories, 2500, "explicit target wins");
  assert.equal(out.plan.targets.protein_g, 200);
  assert.equal(out.plan.targets.carbs_g, 60, "unset macros keep their previous value, NOT the meal sum");
  assert.equal(out.plan.targets.fat_g, 20);
  assert.equal(out.plan.targets.fiber_g, 47, "non-macro targets preserved");
}
{
  const empty = applyDietDelta(dietBase(), { op: "set_targets", targets: {} });
  assert.equal(empty.applied, false);
  assert.equal(empty.reason, "no_targets_given");
  assert.deepEqual(empty.plan.targets, dietBase().targets);
}
// An EMPTY plan cannot produce a 0 kcal target any more.
{
  const emptied = applyDietDelta({ meals: [], targets: { calories: 2200, protein_g: 150 } }, { op: "remove_meal", match: "banana" });
  assert.equal(emptied.plan.targets.calories, 2200, "an empty meal list does not make the target 0");
}

// ---- unknown op is a reported no-op ----
{
  const out = applyDietDelta(dietBase(), { op: "explode_everything" });
  assert.equal(out.applied, false);
  assert.equal(out.reason, "unknown_op");
  assert.equal(out.plan.meals.length, 2);
}

// ---- applyGymDelta ----
{
  const rep = applyGymDelta(gymBase(), { op: "replace_workout", workout: { name: "Cardio", kind: "cardio", items: ["30 min run"], duration_min: 40 } });
  assert.equal(rep.applied, true);
  assert.equal(rep.plan.name, "Cardio");
  assert.equal(rep.plan.kind, "cardio");
  assert.deepEqual(rep.plan.items, ["30 min run"]);
  assert.equal(rep.plan.duration_min, 40);
}
{
  const add = applyGymDelta(gymBase(), { op: "add_exercise", exercise: "Pull-ups 3×8" });
  assert.equal(add.applied, true);
  assert.equal(add.plan.items.length, 3);
  assert.equal(add.plan.items[2], "Pull-ups 3×8");
}
{
  const bare = applyGymDelta(gymBase(), { op: "add_exercise" });
  assert.equal(bare.applied, false);
  assert.equal(bare.reason, "missing_exercise");
}
{
  const rm = applyGymDelta(gymBase(), { op: "remove_exercise", match: "bench" });
  assert.equal(rm.applied, true);
  assert.deepEqual(rm.plan.items, ["Leg press 2×12"]);
}
{
  // "press" is in BOTH "Leg press" and "Bench press" - refuse, do not guess.
  const two = { ...gymBase(), items: ["Leg press 2×12", "Bench press 2×10"] };
  const out = applyGymDelta(two, { op: "remove_exercise", match: "press" });
  assert.equal(out.applied, false);
  assert.equal(out.matched_count, 2);
  assert.equal(out.reason, "ambiguous_match");
  assert.deepEqual(out.plan.items, ["Leg press 2×12", "Bench press 2×10"]);
}
// ---- replace_exercise: swap ONE exercise in place, keep the rest/order ----
{
  const hit = applyGymDelta(gymBase(), { op: "replace_exercise", match: "bench", exercise: "Incline DB press 2×10" });
  assert.deepEqual(hit.plan.items, ["Leg press 2×12", "Incline DB press 2×10"], "swapped in place, order preserved");
}
{
  const miss = applyGymDelta(gymBase(), { op: "replace_exercise", match: "deadlift", exercise: "RDL 2×10" });
  assert.equal(miss.applied, false);
  assert.equal(miss.reason, "no_match");
  assert.deepEqual(miss.plan.items, ["Leg press 2×12", "Bench 2×10"], "no match -> unchanged, never appended");
}
{
  const noMatch = applyGymDelta(gymBase(), { op: "replace_exercise", exercise: "RDL 2×10" });
  assert.equal(noMatch.applied, false);
  assert.deepEqual(noMatch.plan.items, ["Leg press 2×12", "Bench 2×10"], "missing match -> no-op");
}
{
  const noExercise = applyGymDelta(gymBase(), { op: "replace_exercise", match: "bench" });
  assert.equal(noExercise.applied, false);
  assert.equal(noExercise.reason, "missing_exercise");
  assert.deepEqual(noExercise.plan.items, ["Leg press 2×12", "Bench 2×10"]);
}
{
  const unknown = applyGymDelta(gymBase(), { op: "nope" });
  assert.equal(unknown.applied, false);
  assert.equal(unknown.reason, "unknown_op");
  assert.deepEqual(unknown.plan.items, ["Leg press 2×12", "Bench 2×10"]);
}
// normWorkout defaults for a bare replace
{
  const bare = applyGymDelta(gymBase(), { op: "replace_workout", workout: {} });
  assert.equal(bare.plan.kind, "gym");
  assert.equal(bare.plan.duration_min, 50);
  assert.deepEqual(bare.plan.items, []);
}

// ---- applyPlanDelta dispatch ----
assert.equal(applyPlanDelta("gym", gymBase(), { op: "add_exercise", exercise: "x" }).plan.items.length, 3);
assert.equal(applyPlanDelta("diet", dietBase(), { op: "add_meal", meal: { name: "y" } }).plan.meals.length, 3);

// ---- foldPlanPayloads (still returns the DOCUMENT - its callers resolve a plan) ----
assert.deepEqual(foldPlanPayloads("diet", dietBase(), []).meals.length, 2, "empty fold -> base");
{
  const full = { meals: [{ name: "Only", slot: "lunch", calories: 400 }], targets: {} };
  assert.equal(foldPlanPayloads("diet", dietBase(), [full]).meals.length, 1, "a full payload resets the base");
}
{
  // full replace THEN a delta stacks on the replacement
  const full = { meals: [{ name: "Only", slot: "lunch", calories: 400 }], targets: { calories: 400 } };
  const out = foldPlanPayloads("diet", dietBase(), [full, { op: "add_meal", meal: { name: "Salad", slot: "snack", calories: 200 } }]);
  assert.equal(out.meals.length, 2);
  assert.equal(out.targets.calories, 400, "the full payload's target survives the delta");
}
{
  // two deltas stack onto the base scaffold
  const out = foldPlanPayloads("diet", dietBase(), [
    { op: "add_meal", meal: { name: "A", slot: "snack", calories: 100 } },
    { op: "add_meal", meal: { name: "B", slot: "snack", calories: 150 } },
  ]);
  assert.equal(out.meals.length, 4);
  assert.equal(out.targets.calories, 800, "the base target is unchanged by two added meals");
}
{
  // a later full replace beats an earlier full + delta
  const out = foldPlanPayloads("diet", dietBase(), [
    { meals: [{ name: "X", slot: "lunch", calories: 100 }] },
    { op: "add_meal", meal: { name: "Y", slot: "snack", calories: 50 } },
    { meals: [{ name: "Final", slot: "dinner", calories: 700 }] },
  ]);
  assert.equal(out.meals.length, 1);
  assert.equal(out.meals[0].name, "Final");
}
// A REFUSED delta leaves the accumulator exactly as it was, and says why.
{
  const { plan, results } = foldPlanPayloadsDetailed("diet", dietBase(), [
    { op: "add_meal", meal: { name: "Salad bowl", slot: "snack", calories: 200 } },
    { op: "remove_meal", match: "bowl" },              // now ambiguous: Lunch bowl + Salad bowl
    { op: "add_meal", meal: { name: "Curd", slot: "snack", calories: 120 } },
  ]);
  assert.equal(plan.meals.length, 4, "the ambiguous removal changed nothing; the two adds still applied");
  assert.deepEqual(results.map((r) => r.applied), [true, false, true]);
  assert.equal(results[1].reason, "ambiguous_match");
  assert.equal(results[1].matched_count, 2);
}
// non-object entries are skipped
assert.equal(foldPlanPayloads("diet", dietBase(), [null, "x", [], { op: "add_meal", meal: { name: "Z" } }]).meals.length, 3);
// gym fold
{
  const out = foldPlanPayloads("gym", gymBase(), [{ op: "add_exercise", exercise: "Plank 3×30s" }]);
  assert.equal(out.items.length, 3);
}

console.log("plan-merge tests passed");
