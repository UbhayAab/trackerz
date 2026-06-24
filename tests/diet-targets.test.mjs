// The daily macro targets must be DERIVED FROM THE SCAFFOLD (the sum of the
// day's planned meals), not a disconnected hardcoded constant. An explicit
// targets override (set via an AI plan update) wins.

import assert from "node:assert";
import { planForDate, sumMealMacros, setDietPlanOverride, MACRO_TARGETS } from "../src/domain/diet/plan.js";

// 1. Default plan: targets == sum of the day's meals (weekday-agnostic).
{
  const plan = planForDate(new Date("2026-06-22T12:00:00+05:30")); // a Monday (soybean day)
  const scaffold = sumMealMacros(plan.meals);
  assert.equal(plan.macroTargets.calories, scaffold.calories, "calories target = sum of meals");
  assert.equal(plan.macroTargets.protein_g, scaffold.protein_g, "protein target = sum of meals");
  assert.equal(plan.macroTargets.carbs_g, scaffold.carbs_g, "carbs target = sum of meals");
  assert.equal(plan.macroTargets.fat_g, scaffold.fat_g, "fat target = sum of meals");
  assert.ok(scaffold.calories > 0 && scaffold.protein_g > 0, "scaffold actually has macros");
  // fiber/water aren't carried on meals -> fall back to the constant.
  assert.equal(plan.macroTargets.fiber_g, MACRO_TARGETS.fiber_g, "fiber falls back to constant");
  assert.equal(plan.macroTargets.water_ml, MACRO_TARGETS.water_ml, "water falls back to constant");
}

// 2. Override meals (no explicit targets) -> targets follow the new scaffold.
{
  setDietPlanOverride({
    meals: [
      { name: "Big breakfast", slot: "breakfast", calories: 600, protein_g: 40, carbs_g: 60, fat_g: 20 },
      { name: "Lunch", slot: "lunch", calories: 700, protein_g: 50, carbs_g: 70, fat_g: 22 },
    ],
  });
  const plan = planForDate(new Date("2026-06-22T12:00:00+05:30"));
  assert.equal(plan.macroTargets.calories, 1300, "override-meal calories sum");
  assert.equal(plan.macroTargets.protein_g, 90, "override-meal protein sum");
  setDietPlanOverride(null);
}

// 3. Explicit targets override wins outright over the scaffold sum.
{
  setDietPlanOverride({
    meals: [{ name: "x", slot: "lunch", calories: 100, protein_g: 5, carbs_g: 5, fat_g: 5 }],
    targets: { calories: 2500, protein_g: 200 },
  });
  const plan = planForDate(new Date("2026-06-22T12:00:00+05:30"));
  assert.equal(plan.macroTargets.calories, 2500, "explicit calories target wins");
  assert.equal(plan.macroTargets.protein_g, 200, "explicit protein target wins");
  setDietPlanOverride(null);
}

// 4. After reset, back to scaffold-derived defaults.
{
  const plan = planForDate(new Date("2026-06-22T12:00:00+05:30"));
  assert.equal(plan.macroTargets.calories, sumMealMacros(plan.meals).calories, "reset -> scaffold again");
}

console.log("diet-targets.test.mjs: all assertions passed");
