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

// ---------------------------------------------------------------------------
// A DEFAULT IS NOT A DECISION, AND A PARTIAL SUM IS NOT A TOTAL
//
// Verified against the live DB on 2026-08-08: `budgets` holds ZERO rows and has
// never held one, yet every surface reported a 162 g protein target back to the
// owner as his, and the briefs scolded him for missing it (0 hits in 20 logged
// days). Separately, one real food row - a 2500 kcal restaurant dinner logged
// 2026-07-24 IST - carries protein_g/carbs_g/fat_g all NULL, and that day's
// "45.4 g protein" was a sum of two rows out of three presented as the total.
//
// Both are the same error: absent data asserted as measured.

import { computeDietInsights } from "../lib/diet-insights.mjs";
import { effectiveDefault } from "../src/ui/budget-inputs.js";
import { goalValue } from "../src/domain/goals.js";

// The three real rows of 2026-07-24 IST, verbatim from food_logs.
const REAL_0724 = [
  {
    description: "6 boiled eggs",
    meal_slot: "lunch", occurred_at: "2026-07-24T06:30:00.000Z",
    calories_estimate: 432, protein_g: 37.8, carbs_g: 2.4, fat_g: 30,
  },
  {
    description: "1 katori poha",
    meal_slot: "lunch", occurred_at: "2026-07-24T06:37:43.766Z",
    calories_estimate: 368, protein_g: 7.6, carbs_g: 55, fat_g: 12,
  },
  {
    // THE ROW THAT BREAKS NAIVE SUMMING. Calories known, every macro NULL.
    description: "Blueberry pastry, Biscoff, brownie and ice cream, pasta Alfredo full, Mediterranean pizza 9 inch (4 slices), coke. Eaten at Chinlungs.",
    meal_slot: "dinner", occurred_at: "2026-07-24T15:06:45.554Z",
    calories_estimate: 2500, protein_g: null, carbs_g: null, fat_g: null,
  },
];

const AT_0724 = new Date("2026-07-24T22:30:00+05:30");

{
  const r = computeDietInsights(REAL_0724, { protein_g: 162, calories: 2000 }, { now: AT_0724 });

  // The sum itself is unchanged - 45.4 is still what is KNOWN.
  assert.equal(r.protein.today, 45.4, "known protein still sums to 45.4");
  // But it must be flagged as a floor, not a total.
  assert.equal(r.protein.todayPartial, true, "a NULL protein row makes the day's total a floor");
  assert.equal(r.protein.todayUnknownMeals, 1, "exactly one meal has no protein estimate");
  assert.equal(r.protein.partialDays, 1);
  assert.equal(r.proteinSeries.at(-1).partial, true, "the chart series carries the flag too");

  // A day that might have met the target once its unknown meal is priced cannot
  // be counted as proof of a miss.
  assert.equal(
    r.protein.consistentlyShort, false,
    "must not assert 'every logged day came in under target' off a partial sum",
  );
}

{
  // Control: same three meals with the dinner PRICED. Now nothing is partial and
  // the engine is free to assert again.
  const priced = REAL_0724.map((r) => (r.protein_g == null ? { ...r, protein_g: 60, carbs_g: 300, fat_g: 110 } : r));
  const r = computeDietInsights(priced, { protein_g: 162, calories: 2000 }, { now: AT_0724 });
  assert.equal(r.protein.todayPartial, false, "no NULL macro -> not partial");
  assert.equal(r.protein.today, 105.4, "45.4 + 60");
  assert.equal(r.protein.partialDays, 0);
}

{
  // A target nobody set must be reported as a default, not as his.
  const unset = computeDietInsights(REAL_0724, { protein_g: 162, calories: 2000 }, { now: AT_0724 });
  assert.equal(unset.target.userSet, false, "no budgets row -> the target is the scaffold's, not his");
  assert.equal(unset.protein.targetUserSet, false);

  const set = computeDietInsights(REAL_0724, { protein_g: 180, calories: 2000 }, { now: AT_0724, targetUserSet: true });
  assert.equal(set.target.userSet, true, "a saved budgets row makes it genuinely his target");
  assert.equal(set.protein.targetUserSet, true);
}

{
  // The Settings box must not render an unset default as a filled-in value.
  // goalValue is the single test for "did he set this", and it is what the panel
  // and the editor both key off.
  assert.equal(goalValue([], "daily_protein"), null, "empty budgets -> nothing set");
  assert.equal(goalValue([{ kind: "daily_protein", amount: 171 }], "daily_protein"), 171);

  // effectiveDefault names the number actually in force, from the resolved diet
  // targets rather than the static seed - the two can differ once the plan moves.
  const dt = { calories: 2000, protein_g: 162 };
  assert.equal(effectiveDefault("daily_protein", dt), 162);
  assert.equal(effectiveDefault("daily_calories", dt), 2000);
  assert.equal(effectiveDefault("weekly_calories", dt), 14000, "weekly is the daily target x7");
  assert.equal(effectiveDefault("weekly_workouts", dt), 4, "non-diet goals fall back to the seed");
  assert.equal(effectiveDefault("daily_protein", {}), null, "no resolved target -> claim nothing");
}

console.log("diet-targets.test.mjs: default-vs-set and partial-sum assertions passed");
