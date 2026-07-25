// Replays the exact production captures that created phantom workout rows.
//
// Before the negation guard, 5 of the 7 rows in workout_logs came from captures
// where the user said they had NOT trained - including the capture in which they
// reported the bug. habit_days then counted any workout row as "workout done",
// so the next morning's brief congratulated them on a gym session they had
// explicitly denied.
import assert from "node:assert/strict";
import { expandToolCalls } from "../lib/fan-out-expander.mjs";

const NOW = "2026-07-22T09:00:00.000Z";

function run(text, toolCalls = []) {
  return expandToolCalls(toolCalls, { evidence: text, now: NOW });
}
const workouts = (calls) => calls.filter((c) => c.name === "create_workout_log_candidate");
const foods = (calls) => calls.filter((c) => c.name === "create_food_log_candidate");

// ---- the five real captures that must never read as a completed workout ----
const PHANTOMS = [
  "No gym today,",
  "Did not go to gym bro",
  "Did not go to gym today",
  "GOING TO NAGPUR TOMORROW AND DAY AFTER, CALS AND GYM OUT THRE WINDOW, NO GYM TODAY EITHER, OUT ON MON AND TUE, WHIC IS TOMOTTOW",
  "I did not do my workout yesterday, In the ai note here, it says I did workout, wth",
];

for (const text of PHANTOMS) {
  const w = workouts(run(text));
  assert.equal(w.length, 1, `one workout row expected for: ${text}`);
  assert.equal(w[0].arguments.status, "skipped", `must be recorded as skipped: ${text}`);
}

// Even when the model itself wrongly emits a positive workout, the denial wins.
const withModelRow = run("Did not go to gym bro", [
  { name: "create_workout_log_candidate", arguments: { description: "gym session" }, confidence: 0.9 },
]);
assert.equal(workouts(withModelRow).length, 1);
assert.equal(workouts(withModelRow)[0].arguments.status, "skipped");

// ---- real workouts still land, marked done ----
for (const text of ["in gym, just doing cardio today", "did workout A, bench 3x10 60kg", "Walked 10k step, no gym"]) {
  const w = workouts(run(text));
  assert.equal(w.length, 1, `workout expected: ${text}`);
  assert.equal(w[0].arguments.status, "done", `must be done: ${text}`);
}

// ---- the macro-less "lunch (auto from spend)" row is gone ----
// Production capture: "Ate 2 home made small idli with some rice sambar and
// chutney. Also yesterday lunch paid 110" produced a second food row described
// as "lunch (auto from spend)" with NULL calories/protein/carbs/fat.
const spendOnly = run("Also yesterday lunch paid 110", [
  { name: "create_expense_candidate", arguments: { amount: 110, description: "lunch", occurred_at: "2026-07-21T12:00:00+05:30" }, confidence: 1 },
]);
assert.equal(foods(spendOnly).length, 0, "a bare meal-slot spend must not create a food row");

// A named dish still fans out from the spend.
const namedDish = run("paid 240 for a paneer roll", [
  { name: "create_expense_candidate", arguments: { amount: 240, description: "paneer roll", occurred_at: "2026-07-22T12:00:00+05:30" }, confidence: 1 },
]);
assert.equal(foods(namedDish).length, 1, "a named dish should still fan out to food");

// ---- food denial ----
const skippedLunch = run("skipped lunch today");
assert.equal(foods(skippedLunch).length, 0, "a skipped meal must not be logged as eaten");

// ...but an ingredient-level "no" is not a denial.
assert.equal(foods(run("ate rice with no salt")).length, 1, "'no salt' is not a denied meal");

// ---- the SECOND half of the same bug: reading a skipped row back ----
//
// Writing status='skipped' was only ever half the fix. The diet hub's reconciler
// took the first workout row of the day regardless of status, so tapping "Skipped"
// on Home ticked the workout item in the panel directly below it as DONE - the app
// contradicting the user on the same screen, one scroll apart. The day-logs query
// did not even select `status`, so the reconciler could not have known.
const { reconcilePlan } = await import("../src/domain/diet/reconcile.js");

const plan = { meals: [], water: [], workout: { id: "workout-mon", name: "Workout A", items: [] } };

const skipped = reconcilePlan(plan, { workoutLogs: [{ id: "w1", status: "skipped", occurred_at: NOW }] });
assert.equal(skipped["workout-mon"], undefined, "'no gym today' must not tick the day's workout item");

const rest = reconcilePlan(plan, { workoutLogs: [{ id: "w2", status: "rest", occurred_at: NOW }] });
assert.equal(rest["workout-mon"], undefined, "a rest day must not tick the day's workout item");

const done = reconcilePlan(plan, { workoutLogs: [{ id: "w3", status: "done", occurred_at: NOW }] });
assert.equal(done["workout-mon"]?.recordId, "w3", "a real session still ticks it");

// Legacy rows written before the status column are real sessions.
const legacy = reconcilePlan(plan, { workoutLogs: [{ id: "w4", occurred_at: NOW }] });
assert.equal(legacy["workout-mon"]?.recordId, "w4", "null status means a logged session");

// Skipped first, then actually went: the real session must win.
const both = reconcilePlan(plan, {
  workoutLogs: [
    { id: "w5", status: "skipped", occurred_at: NOW },
    { id: "w6", status: "done", occurred_at: NOW },
  ],
});
assert.equal(both["workout-mon"]?.recordId, "w6", "a real session outranks an earlier skip");

console.log("phantom-workout.test.mjs OK");
