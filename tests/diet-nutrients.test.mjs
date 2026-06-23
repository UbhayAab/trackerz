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

// Proportional fill: half the day's calories => half the plan value; full => plan; none => 0.
assert.equal(nutrientsSoFar("soybean", 0.5).find((n) => n.key === "zinc").current, Math.round(11.2 * 0.5 * 100) / 100);
assert.equal(nutrientsSoFar("soybean", 1).find((n) => n.key === "protein").current, 164);
assert.equal(nutrientsSoFar("soybean", 0).find((n) => n.key === "iron").current, 0);

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
