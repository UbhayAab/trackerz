// Paste-a-plan import: a whole weekly plan pasted from another AI becomes a
// permanent user_plans payload — diet as {days:{Monday:{meals,targets}}} and
// gym as {days:{Monday:{name,kind,items}}} — and planForDate resolves the right
// day, falling back to the standing scaffold for days the paste doesn't cover.
import assert from "node:assert/strict";
import {
  planForDate, setDietPlanOverride, setGymPlanOverride, setDatedPlanOverrides, localDateKey,
} from "../src/domain/diet/plan.js";

function reset() { setDietPlanOverride(null); setGymPlanOverride(null); setDatedPlanOverrides({}); }

const MON = new Date(2026, 6, 6);
const TUE = new Date(2026, 6, 7);
const SUN = new Date(2026, 6, 12);

// --- permanent gym plan: single repeating workout ----------------------------
reset();
setGymPlanOverride({ name: "Full body", kind: "gym", duration_min: 45, items: ["Squat 3x8", "Bench press 3x8", "Row 3x10"] });
for (const d of [MON, TUE, SUN]) {
  const p = planForDate(d);
  assert.equal(p.customWorkout, true, `permanent gym override applies on ${localDateKey(d)}`);
  assert.equal(p.workout.name, "Full body");
  assert.equal(p.workout.items.length, 3);
}

// --- permanent gym plan: weekly split via days map ---------------------------
reset();
setGymPlanOverride({
  days: {
    Monday: { name: "Push day", kind: "gym", items: ["Bench press 4x8", "OHP 3x10", "Dips 3x12"] },
    tue: { name: "Pull day", kind: "gym", items: ["Deadlift 3x5", "Row 4x10"] }, // lowercase short key
  },
});
const gymMon = planForDate(MON);
assert.equal(gymMon.workout.name, "Push day");
assert.equal(gymMon.customWorkout, true);
const gymTue = planForDate(TUE);
assert.equal(gymTue.workout.name, "Pull day", "case-insensitive short day key resolves");
const gymSun = planForDate(SUN);
assert.equal(gymSun.customWorkout, false, "uncovered day falls back to the standing cycle");
assert.ok(gymSun.workout.name.startsWith("Workout"), "Sunday keeps Workout A/B");

// --- a dated one-shot delta folds onto the permanent gym day -----------------
setDatedPlanOverrides({ gym: { [localDateKey(MON)]: [{ op: "add_exercise", exercise: "Pull-ups 3x8" }] } });
const gymMonDelta = planForDate(MON);
assert.equal(gymMonDelta.workout.name, "Push day", "delta folds onto the imported plan, not the scaffold");
assert.equal(gymMonDelta.workout.items.length, 4, "3 imported items + 1 added");
setDatedPlanOverrides({});

// --- permanent weekly DIET plan via days map ---------------------------------
reset();
setDietPlanOverride({
  days: {
    Monday: {
      meals: [
        { name: "Oats bowl", slot: "breakfast", calories: 350, protein_g: 20 },
        { name: "Chicken rice", slot: "lunch", calories: 600, protein_g: 45 },
      ],
      targets: { calories: 1900, protein_g: 150 },
    },
  },
});
const dietMon = planForDate(MON);
assert.equal(dietMon.customDiet, true);
assert.equal(dietMon.meals.length, 2);
assert.equal(dietMon.meals[0].name, "Oats bowl");
assert.equal(dietMon.macroTargets.calories, 1900, "explicit targets win");
const dietTue = planForDate(TUE);
assert.equal(dietTue.customDiet, false, "weekday without an entry keeps the scaffold");
assert.ok(dietTue.meals.length >= 3);

// --- single-day permanent diet payload still applies every day ---------------
reset();
setDietPlanOverride({ meals: [{ name: "Same every day", slot: "lunch", calories: 500 }] });
assert.equal(planForDate(MON).meals[0].name, "Same every day");
assert.equal(planForDate(SUN).meals[0].name, "Same every day");

// --- dated delta folds onto the weekly diet day ------------------------------
reset();
setDietPlanOverride({ days: { Monday: { meals: [{ name: "Oats bowl", slot: "breakfast", calories: 350 }] } } });
setDatedPlanOverrides({ diet: { [localDateKey(MON)]: [{ op: "add_meal", meal: { name: "Paneer salad", slot: "dinner", calories: 400 } }] } });
const mixed = planForDate(MON);
assert.equal(mixed.meals.length, 2, "imported day (1 meal) + delta add (1)");
assert.deepEqual(mixed.meals.map((m) => m.name).sort(), ["Oats bowl", "Paneer salad"]);

reset();
console.log("plan-import tests passed");
