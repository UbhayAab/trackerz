// Recurring / date-scoped plan changes: "for the next 4 Mondays I'll have paneer
// salad" must rewrite exactly those days' plan (diet AND gym), not log/tick.
import assert from "node:assert/strict";
import {
  parsePlanScope, localDateKey, planForDate,
  setDietPlanOverride, setDatedPlanOverrides,
} from "../src/domain/diet/plan.js";

// --- parsePlanScope ---------------------------------------------------------
assert.deepEqual(parsePlanScope("permanent"), { kind: "permanent", dates: [] });
assert.deepEqual(parsePlanScope(""), { kind: "permanent", dates: [] });
assert.deepEqual(parsePlanScope(null), { kind: "permanent", dates: [] });
assert.deepEqual(parsePlanScope("2026-07-06"), { kind: "dates", dates: ["2026-07-06"] });
{
  const r = parsePlanScope("2026-07-06,2026-07-13,2026-07-20,2026-07-27,2026-07-01,2026-07-08,2026-07-15,2026-07-22");
  assert.equal(r.kind, "dates");
  assert.equal(r.dates.length, 8, "8 concrete dates from 'next 4 Mondays and Wednesdays'");
}
assert.deepEqual(parsePlanScope("2026-07-06,2026-07-06"), { kind: "dates", dates: ["2026-07-06"] }, "de-duped");
assert.deepEqual(parsePlanScope("garbage"), { kind: "none", dates: [] }, "non-date, non-permanent -> ignored");

// --- localDateKey -----------------------------------------------------------
assert.equal(localDateKey(new Date(2026, 6, 6)), "2026-07-06"); // month is 0-based (6 = July)
assert.equal(localDateKey(new Date(2026, 0, 9)), "2026-01-09");

// --- planForDate resolves dated override on its date, falls back off-date ----
function reset() { setDietPlanOverride(null); setDatedPlanOverrides({}); }

const MON = new Date(2026, 6, 6);   // a date we'll override
const TUE = new Date(2026, 6, 7);   // an off-list date
const monKey = localDateKey(MON);

reset();
setDatedPlanOverrides({
  diet: { [monKey]: { meals: [{ name: "Paneer salad", slot: "dinner", calories: 400, protein_g: 30 }] } },
  gym: { [monKey]: { name: "Push day", items: ["Bench press 3×10 60kg", "Shoulder press 3×10"] } },
});

const monPlan = planForDate(MON);
assert.equal(monPlan.customDiet, true, "Monday has a dated diet override");
assert.equal(monPlan.meals.length, 1);
assert.equal(monPlan.meals[0].name, "Paneer salad");
assert.equal(monPlan.customWorkout, true, "Monday has a dated gym override");
assert.equal(monPlan.workout.name, "Push day");
assert.equal(monPlan.workout.items.length, 2);

const tuePlan = planForDate(TUE);
assert.equal(tuePlan.customDiet, false, "Tuesday is NOT in the override list -> default plan");
assert.ok(tuePlan.meals.length >= 3, "Tuesday gets the fixed scaffold meals");
assert.equal(tuePlan.customWorkout, false, "Tuesday keeps the standing workout");

// --- permanent override applies everywhere there's no dated entry -----------
reset();
setDietPlanOverride({ meals: [{ name: "Standing custom meal", slot: "lunch", calories: 600, protein_g: 40 }] });
assert.equal(planForDate(MON).meals[0].name, "Standing custom meal");
assert.equal(planForDate(TUE).meals[0].name, "Standing custom meal");

// --- dated override wins over a permanent one on its date -------------------
setDatedPlanOverrides({ diet: { [monKey]: { meals: [{ name: "Paneer salad", slot: "dinner", calories: 400 }] } } });
assert.equal(planForDate(MON).meals[0].name, "Paneer salad", "dated beats permanent on its date");
assert.equal(planForDate(TUE).meals[0].name, "Standing custom meal", "permanent still applies off-date");

reset();
console.log("plan-overrides tests passed");
