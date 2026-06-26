// Standalone node:assert test for the diet auto-check reconciler.
// Run: node tests/diet-reconcile.test.mjs
import assert from "node:assert";
import { planForDate } from "../src/domain/diet/plan.js";
import { scoreFoodToMeal, reconcilePlan, tokenize } from "../src/domain/diet/reconcile.js";

// A Monday (soybean day) so meals = shake/eggcurry/fruit/salad.
const MON = new Date(2026, 5, 22); // 2026-06-22
const plan = planForDate(MON);
const meal = (id) => plan.meals.find((m) => m.id === id);

// --- tokenize strips stopwords / units / numbers, folds plurals ---
{
  const t = tokenize("Had 2 rotis with egg curry");
  assert.ok(t.includes("roti") && t.includes("egg") && t.includes("curry"), "keeps dish words, folds rotis->roti");
  assert.ok(!t.includes("had") && !t.includes("2") && !t.includes("with"), "drops stopwords/numbers");
}

// --- a clear free-form food strongly matches its plan meal ---
{
  const s = scoreFoodToMeal({ description: "egg curry and 2 rotis", meal_slot: "lunch" }, meal("meal-eggcurry"));
  assert.ok(s >= 0.6, `egg curry should auto-match (got ${s})`);
}

// --- "cake" matches nothing in the plan ---
{
  for (const m of plan.meals) {
    assert.ok(scoreFoodToMeal({ description: "chocolate cake", meal_slot: "dinner" }, m) < 0.6, `cake must not auto-match ${m.id}`);
  }
}

// --- slot-only ("had dinner") lands as a suggestion, not an auto-tick ---
{
  const r = reconcilePlan(plan, { foodLogs: [{ id: "f1", description: "dinner", meal_slot: "dinner" }] });
  assert.equal(r["meal-salad"]?.source, "suggested", "slot-only match => suggested");
}

// --- full reconcile: food auto-ticks, workout + exact-ml hydration auto-tick ---
{
  const r = reconcilePlan(plan, {
    foodLogs: [{ id: "f1", meal_name: "Protein milk shake", meal_slot: "breakfast" }],
    workoutLogs: [{ id: "w1", description: "did legs at gym" }],
    hydrationLogs: [{ id: "h1", ml: plan.water[0].ml }],
  });
  assert.equal(r["meal-shake"].source, "auto", "shake auto-ticks");
  assert.equal(r["meal-shake"].recordId, "f1");
  assert.equal(r[plan.workout.id].source, "auto", "any workout row ticks the day's workout");
  assert.equal(r[plan.water[0].id].source, "auto", "exact-ml hydration ticks the water slot");
}

// --- greedy: two logs can't both claim the same meal ---
{
  const r = reconcilePlan(plan, { foodLogs: [
    { id: "a", meal_name: "egg curry rotis", meal_slot: "lunch" },
    { id: "b", description: "egg curry again", meal_slot: "lunch" },
  ] });
  assert.equal(r["meal-eggcurry"].source, "auto");
  assert.ok(["a", "b"].includes(r["meal-eggcurry"].recordId), "one log claims the meal");
  // Only one meal id is the eggcurry; the other log finds no second egg-curry meal.
  const claimed = Object.values(r).filter((v) => v.recordId === "a").length + Object.values(r).filter((v) => v.recordId === "b").length;
  assert.equal(claimed, 1, "the duplicate log does not double-tick");
}

console.log("diet-reconcile.test.mjs ✓");
