// Recurring / date-scoped plan changes: "for the next 4 Mondays I'll have paneer
// salad" must rewrite exactly those days' plan (diet AND gym), not log/tick.
import assert from "node:assert/strict";
import {
  parsePlanScope, localDateKey, planForDate,
  setDietPlanOverride, setGymPlanOverride, setDatedPlanOverrides,
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
function reset() { setDietPlanOverride(null); setGymPlanOverride(null); setDatedPlanOverrides({}); }

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

// --- permanent GYM override (the exact bug: "here's my Monday-Friday gym
// schedule" must actually show up, and stay off-date on days it doesn't cover) --
reset();
setGymPlanOverride({
  name: "Push", kind: "gym", duration_min: 45, items: ["Bench press 3×8", "OHP 3×10"],
});
assert.equal(planForDate(MON).customWorkout, true, "a flat permanent gym override applies");
assert.equal(planForDate(MON).workout.name, "Push");
assert.equal(planForDate(TUE).workout.name, "Push", "flat override applies every day, not just Monday");

// A per-weekday {days:{...}} permanent payload -- the literal "Monday to Friday"
// shape the SYSTEM_PROMPT documents. Sat/Sun aren't covered -> falls back to the
// fixed scaffold default, not blank/broken.
reset();
setGymPlanOverride({
  days: {
    Mon: { name: "Push", items: ["Bench press 3×8"] },
    Tue: { name: "Pull", items: ["Bent row 3×8"] },
    Wed: { name: "Legs", items: ["Squat 3×8"] },
    Thu: { name: "Push", items: ["Incline press 3×8"] },
    Fri: { name: "Pull", items: ["Lat pulldown 3×8"] },
  },
});
const SAT = new Date(2026, 6, 11); // Saturday, not in the Mon-Fri schedule
const SUN = new Date(2026, 6, 12);
assert.equal(planForDate(MON).workout.name, "Push", "Monday gets its named day");
assert.equal(planForDate(new Date(2026, 6, 7)).workout.name, "Pull", "Tuesday gets its named day");
assert.equal(planForDate(new Date(2026, 6, 8)).workout.name, "Legs", "Wednesday gets its named day");
assert.equal(planForDate(SAT).customWorkout, false, "Saturday isn't in the Mon-Fri schedule -> falls back to scaffold");
assert.ok(planForDate(SAT).workout.name, "fallback workout still has a name, not blank");
assert.equal(planForDate(SUN).customWorkout, false, "Sunday likewise falls back");

// --- dated gym override wins over permanent on its date; a DELTA on a date
// folds onto the PERMANENT override as its base (not the fixed scaffold) -------
reset();
setGymPlanOverride({ name: "Push", kind: "gym", duration_min: 45, items: ["Bench press 3×8", "OHP 3×10"] });
setDatedPlanOverrides({ gym: { [monKey]: [{ op: "add_exercise", exercise: "Dips 3×10" }] } });
const gymDeltaOnPermanent = planForDate(MON);
assert.equal(gymDeltaOnPermanent.workout.name, "Push", "delta preserves the permanent override's identity");
assert.deepEqual(gymDeltaOnPermanent.workout.items, ["Bench press 3×8", "OHP 3×10", "Dips 3×10"], "delta folds onto the PERMANENT base, not the fixed weekday scaffold");
assert.equal(planForDate(TUE).workout.name, "Push", "off-date still shows the plain permanent override");

// --- one-shot DELTA edits fold onto the scaffold for that date --------------
reset();
const WED = new Date(2026, 6, 8); // a Wednesday (paneer-soy) — scaffold has 4 meals
const wedKey = localDateKey(WED);
const scaffoldMealCount = planForDate(new Date(2026, 6, 15)).meals.length; // another Wed, no override
assert.equal(scaffoldMealCount, 4, "baseline scaffold has 4 meals");

setDatedPlanOverrides({ diet: { [wedKey]: [{ op: "add_meal", meal: { name: "Salad bowl", slot: "snack", calories: 200, protein_g: 10 } }] } });
const wedPlan = planForDate(WED);
assert.equal(wedPlan.customDiet, true, "a delta marks the day custom");
assert.equal(wedPlan.meals.length, 5, "salad bowl adds on TOP of the 4 scaffold meals (not replace)");
assert.ok(wedPlan.meals.some((m) => m.name === "Salad bowl"));
assert.ok(planForDate(new Date(2026, 6, 15)).meals.length === 4, "an off-date day is untouched");

// stacking: add one meal, drop another, on the same date
setDatedPlanOverrides({ diet: { [wedKey]: [
  { op: "add_meal", meal: { name: "Salad bowl", slot: "snack", calories: 200 } },
  { op: "remove_meal", match: "banana" },
] } });
const stacked = planForDate(WED);
assert.ok(stacked.meals.some((m) => m.name === "Salad bowl"), "added meal present");
assert.ok(!stacked.meals.some((m) => m.name.toLowerCase().includes("banana")), "banana snack removed");
assert.equal(stacked.meals.length, 4, "4 scaffold - 1 banana + 1 salad");

// a full replace followed by a delta on the same date
setDatedPlanOverrides({ diet: { [wedKey]: [
  { meals: [{ name: "Custom base", slot: "lunch", calories: 500 }] },
  { op: "add_meal", meal: { name: "Extra shake", slot: "breakfast", calories: 300 } },
] } });
const mixed = planForDate(WED);
assert.equal(mixed.meals.length, 2, "full replace (1) + delta add (1)");
assert.deepEqual(mixed.meals.map((m) => m.name).sort(), ["Custom base", "Extra shake"]);

// --- gym one-shot edits ------------------------------------------------------
reset();
setDatedPlanOverrides({ gym: { [monKey]: [{ op: "replace_workout", workout: { name: "Cardio only", kind: "cardio", items: ["30 min treadmill"] } }] } });
const gSwap = planForDate(MON);
assert.equal(gSwap.customWorkout, true);
assert.equal(gSwap.workout.name, "Cardio only");
assert.equal(gSwap.workout.kind, "cardio");

setDatedPlanOverrides({ gym: { [monKey]: [{ op: "add_exercise", exercise: "Pull-ups 3×8" }] } });
const gAdd = planForDate(MON);
assert.equal(gAdd.customWorkout, true, "add_exercise folds onto the standing Workout A");
assert.ok(gAdd.workout.items.some((it) => it.includes("Pull-ups")));
assert.equal(gAdd.workout.items.length, 10, "Workout A's 9 items + 1");

reset();
console.log("plan-overrides tests passed");
