import assert from "node:assert/strict";
import { NUTRIENTS, planNutrients, nutrientsSoFar, gauge } from "../src/domain/diet/nutrients.js";

const keys = NUTRIENTS.map((n) => n.key);
for (const must of ["calories", "protein", "fiber", "sodium", "zinc", "iron", "calcium", "magnesium", "potassium", "selenium", "iodine", "vit_a", "vit_b12", "vit_c", "vit_d", "vit_k"]) {
  assert.ok(keys.includes(must), `full panel missing ${must}`);
}
assert.ok(NUTRIENTS.length >= 25, "expected the full ~30-nutrient panel");
assert.equal(new Set(keys).size, keys.length, "nutrient keys must be unique");

const soy = planNutrients("soybean");
assert.equal(soy.find((n) => n.key === "zinc").plan, 11.2);
assert.equal(soy.find((n) => n.key === "sodium").plan, 1739);
assert.ok(soy.find((n) => n.key === "sodium").limit, "sodium is an upper-limit nutrient");
assert.equal(planNutrients("paneer-soy").find((n) => n.key === "calcium").plan, 1376);

// MEASURED vs NOT MEASURED - the whole point of this module.
//
// It used to return `current = plan[nutrient] * caloriesEaten/calorieTarget` for
// every nutrient, so the panel drew vitamin C in the same gauge as protein. A
// 3,367 kcal Taco Bell day therefore rendered a full 451 mg of vitamin C. A
// nutrient the logs cannot carry must never come back as a number.
{
  const half = nutrientsSoFar("soybean", {
    measured: { calories: 1000, protein: 82, carbs: 95, fat: 38 }, planAdherence: 0.5,
  });
  const zinc = half.find((n) => n.key === "zinc");
  assert.equal(zinc.measured, false, "zinc is not on a food_logs row");
  assert.equal(zinc.current, null, "an unmeasured nutrient must be null, never a number");
  assert.equal(zinc.plannedSoFar, Math.round(11.2 * 0.5 * 100) / 100, "the plan reference still scales");

  const protein = half.find((n) => n.key === "protein");
  assert.equal(protein.measured, true);
  assert.equal(protein.current, 82, "a measured macro is the real sum, not a scaled plan value");

  // Eating MORE off-plan food must not raise a single micronutrient.
  const binge = nutrientsSoFar("soybean", {
    measured: { calories: 3367, protein: 160, carbs: 322, fat: 174 }, planAdherence: 0,
  });
  assert.equal(binge.find((n) => n.key === "vit_c").current, null);
  assert.equal(binge.find((n) => n.key === "vit_c").plannedSoFar, 0,
    "no plan ticked means no claim about vitamin C, whatever the calorie count");
  assert.equal(binge.find((n) => n.key === "calories").current, 3367);

  // Absent measurements stay null rather than collapsing to 0.
  const nothing = nutrientsSoFar("soybean", {});
  assert.equal(nothing.find((n) => n.key === "protein").current, null);
  assert.equal(nothing.find((n) => n.key === "iron").current, null);
}

// Kinds drive the gauge semantics.
assert.equal(soy.find((n) => n.key === "sodium").kind, "limit");
assert.equal(soy.find((n) => n.key === "protein").kind, "target");
assert.equal(soy.find((n) => n.key === "zinc").kind, "floor");

// Range gauge: target sits at the centre (50%); over-target is visible, not clamped silently.
assert.equal(gauge({ current: 162, target: 162, kind: "target" }).position, 50);
assert.equal(gauge({ current: 162, target: 162, kind: "target" }).status, "good");
assert.equal(gauge({ current: 11.2, target: 11, kind: "floor" }).status, "good");
assert.equal(gauge({ current: 5, target: 11, kind: "floor" }).status, "bad");
assert.equal(gauge({ current: 864, target: 400, kind: "floor" }).over, true); // way over -> pegged + flagged
assert.equal(gauge({ current: 1739, target: 2300, kind: "limit", limit: true }).status, "good"); // under the cap
assert.equal(gauge({ current: 3000, target: 2300, kind: "limit", limit: true }).status, "bad"); // over the cap
assert.ok(gauge({ current: 5141, target: 3400, kind: "floor" }).position > 50, "over target -> pointer right of centre");

console.log("diet-nutrients tests passed");
