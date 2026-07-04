// One-shot plan edits: applyDietDelta / applyGymDelta / foldPlanPayloads.
import assert from "node:assert/strict";
import {
  isPlanDelta, applyDietDelta, applyGymDelta, applyPlanDelta, foldPlanPayloads,
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
  assert.equal(out.meals.length, 3);
  assert.equal(out.meals[2].name, "Salad bowl");
  assert.equal(out.meals[2].time, "16:00");
  assert.equal(out.targets.calories, 1000, "targets track the new meal");
  assert.equal(out.targets.protein_g, 80);
  assert.equal(out.targets.carbs_g, 80);
  assert.equal(out.targets.fat_g, 28);
  assert.equal(out.targets.fiber_g, 47, "non-macro targets preserved");
  assert.equal(out.targets.water_ml, 3450);
}

// add_meal normalizes a bad slot + missing macros
{
  const out = applyDietDelta(dietBase(), { op: "add_meal", meal: { name: "Mystery", slot: "brunch" } });
  const added = out.meals[2];
  assert.equal(added.slot, "other", "invalid slot -> other");
  assert.equal(added.calories, 0);
  assert.equal(added.protein_g, 0);
}

// add_meal accepts food-log field aliases (meal_name/description/calories_estimate)
{
  const out = applyDietDelta(dietBase(), { op: "add_meal", meal: { meal_name: "Curd", description: "200g curd", calories_estimate: 120, protein_g: 11 } });
  assert.equal(out.meals[2].name, "Curd");
  assert.equal(out.meals[2].detail, "200g curd");
  assert.equal(out.meals[2].calories, 120);
}

// ---- remove_meal ----
assert.equal(applyDietDelta(dietBase(), { op: "remove_meal", match: "banana" }).meals.length, 2, "no match -> no-op");
{
  const bySlot = applyDietDelta(dietBase(), { op: "remove_meal", match: "lunch" });
  assert.equal(bySlot.meals.length, 1);
  assert.equal(bySlot.meals[0].name, "Shake");
  assert.equal(bySlot.targets.calories, 300, "targets shrink after removal");
}
{
  const byName = applyDietDelta(dietBase(), { op: "remove_meal", match: "BOWL" });
  assert.equal(byName.meals.length, 1, "name substring match is case-insensitive");
  assert.equal(byName.meals[0].name, "Shake");
}

// ---- replace_meal ----
{
  const hit = applyDietDelta(dietBase(), { op: "replace_meal", match: "lunch", meal: { name: "Paneer wrap", slot: "lunch", calories: 600, protein_g: 45 } });
  assert.equal(hit.meals.length, 2);
  assert.equal(hit.meals[1].name, "Paneer wrap");
  assert.equal(hit.targets.calories, 900);
}
{
  const miss = applyDietDelta(dietBase(), { op: "replace_meal", match: "dinner", meal: { name: "New dinner", slot: "dinner", calories: 400 } });
  assert.equal(miss.meals.length, 3, "no match -> appended");
}

// ---- set_targets ----
{
  const out = applyDietDelta(dietBase(), { op: "set_targets", targets: { calories: 2500, protein_g: 200 } });
  assert.equal(out.meals.length, 2, "meals untouched");
  assert.equal(out.targets.calories, 2500, "explicit target wins");
  assert.equal(out.targets.protein_g, 200);
  assert.equal(out.targets.carbs_g, 60, "unset macros still track the meal sum");
  assert.equal(out.targets.fat_g, 20);
}

// ---- unknown op is a no-op ----
{
  const out = applyDietDelta(dietBase(), { op: "explode_everything" });
  assert.equal(out.meals.length, 2);
}

// ---- applyGymDelta ----
{
  const rep = applyGymDelta(gymBase(), { op: "replace_workout", workout: { name: "Cardio", kind: "cardio", items: ["30 min run"], duration_min: 40 } });
  assert.equal(rep.name, "Cardio");
  assert.equal(rep.kind, "cardio");
  assert.deepEqual(rep.items, ["30 min run"]);
  assert.equal(rep.duration_min, 40);
}
{
  const add = applyGymDelta(gymBase(), { op: "add_exercise", exercise: "Pull-ups 3×8" });
  assert.equal(add.items.length, 3);
  assert.equal(add.items[2], "Pull-ups 3×8");
}
{
  const rm = applyGymDelta(gymBase(), { op: "remove_exercise", match: "bench" });
  assert.deepEqual(rm.items, ["Leg press 2×12"]);
}
// ---- replace_exercise: swap ONE exercise in place, keep the rest/order ----
{
  const hit = applyGymDelta(gymBase(), { op: "replace_exercise", match: "bench", exercise: "Incline DB press 2×10" });
  assert.deepEqual(hit.items, ["Leg press 2×12", "Incline DB press 2×10"], "swapped in place, order preserved");
}
{
  const miss = applyGymDelta(gymBase(), { op: "replace_exercise", match: "deadlift", exercise: "RDL 2×10" });
  assert.deepEqual(miss.items, ["Leg press 2×12", "Bench 2×10"], "no match -> unchanged (not appended, unlike replace_meal)");
}
{
  const noMatch = applyGymDelta(gymBase(), { op: "replace_exercise", exercise: "RDL 2×10" });
  assert.deepEqual(noMatch.items, ["Leg press 2×12", "Bench 2×10"], "missing match -> no-op");
}
{
  const noExercise = applyGymDelta(gymBase(), { op: "replace_exercise", match: "bench" });
  assert.deepEqual(noExercise.items, ["Leg press 2×12", "Bench 2×10"], "missing exercise -> no-op");
}
assert.deepEqual(applyGymDelta(gymBase(), { op: "nope" }).items, ["Leg press 2×12", "Bench 2×10"], "unknown op -> unchanged");
// normWorkout defaults for a bare replace
{
  const bare = applyGymDelta(gymBase(), { op: "replace_workout", workout: {} });
  assert.equal(bare.kind, "gym");
  assert.equal(bare.duration_min, 50);
  assert.deepEqual(bare.items, []);
}

// ---- applyPlanDelta dispatch ----
assert.equal(applyPlanDelta("gym", gymBase(), { op: "add_exercise", exercise: "x" }).items.length, 3);
assert.equal(applyPlanDelta("diet", dietBase(), { op: "add_meal", meal: { name: "y" } }).meals.length, 3);

// ---- foldPlanPayloads ----
assert.deepEqual(foldPlanPayloads("diet", dietBase(), []).meals.length, 2, "empty fold -> base");
{
  const full = { meals: [{ name: "Only", slot: "lunch", calories: 400 }], targets: {} };
  assert.equal(foldPlanPayloads("diet", dietBase(), [full]).meals.length, 1, "a full payload resets the base");
}
{
  // full replace THEN a delta stacks on the replacement
  const full = { meals: [{ name: "Only", slot: "lunch", calories: 400 }] };
  const out = foldPlanPayloads("diet", dietBase(), [full, { op: "add_meal", meal: { name: "Salad", slot: "snack", calories: 200 } }]);
  assert.equal(out.meals.length, 2);
  assert.equal(out.targets.calories, 600);
}
{
  // two deltas stack onto the base scaffold
  const out = foldPlanPayloads("diet", dietBase(), [
    { op: "add_meal", meal: { name: "A", slot: "snack", calories: 100 } },
    { op: "add_meal", meal: { name: "B", slot: "snack", calories: 150 } },
  ]);
  assert.equal(out.meals.length, 4);
  assert.equal(out.targets.calories, 800 + 100 + 150);
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
// non-object entries are skipped
assert.equal(foldPlanPayloads("diet", dietBase(), [null, "x", [], { op: "add_meal", meal: { name: "Z" } }]).meals.length, 3);
// gym fold
{
  const out = foldPlanPayloads("gym", gymBase(), [{ op: "add_exercise", exercise: "Plank 3×30s" }]);
  assert.equal(out.items.length, 3);
}

console.log("plan-merge tests passed");
