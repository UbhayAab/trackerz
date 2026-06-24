// The gym tracker turns the plan's free-text workout items into structured,
// loggable exercises (sets × reps + muscle group).

import assert from "node:assert";
import { planForDate, prescribedExercises, muscleFor } from "../src/domain/diet/plan.js";

// muscleFor keyword mapping
{
  assert.equal(muscleFor("Leg press"), "quads");
  assert.equal(muscleFor("DB Romanian deadlift"), "hamstrings");
  assert.equal(muscleFor("Machine chest press"), "chest");
  assert.equal(muscleFor("Lat pulldown"), "back");
  assert.equal(muscleFor("Seated cable row"), "back");
  assert.equal(muscleFor("Machine shoulder press"), "shoulders");
  assert.equal(muscleFor("DB lateral raise"), "shoulders");
  assert.equal(muscleFor("Cable triceps pushdown"), "triceps");
  assert.equal(muscleFor("DB curl"), "biceps");
  assert.equal(muscleFor("Plank"), "core");
  assert.equal(muscleFor("Dead bug"), "core");
  assert.equal(muscleFor("Treadmill 8 min easy"), "cardio");
  assert.equal(muscleFor("Something weird"), "other");
}

// Workout A (a Monday) parses into the right exercises.
{
  const plan = planForDate(new Date("2026-06-22T09:00:00+05:30")); // Monday -> Workout A
  const ex = prescribedExercises(plan.workout);
  assert.ok(ex.length >= 8, "all workout items represented");

  const legPress = ex.find((e) => /leg press/i.test(e.name));
  assert.ok(legPress, "leg press present");
  assert.equal(legPress.sets, 2, "leg press 2 sets");
  assert.equal(legPress.reps, 12, "leg press 12 reps");
  assert.equal(legPress.muscle, "quads");
  assert.equal(legPress.kind, "strength");
  assert.equal(legPress.loggable, true);

  const plank = ex.find((e) => /plank/i.test(e.name));
  assert.equal(plank.reps, 30, "plank 30");
  assert.equal(plank.repsUnit, "sec", "plank is a timed hold");
  assert.equal(plank.muscle, "core");

  const treadmill = ex.find((e) => /treadmill/i.test(e.name));
  assert.equal(treadmill.kind, "note", "treadmill warmup has no S×R -> note");
  assert.equal(treadmill.loggable, false, "cardio/warmup not loggable as a strength set");
}

// Cardio "forgiven" day -> nothing loggable as a strength set.
{
  const plan = planForDate(new Date("2026-06-23T09:00:00+05:30")); // Tuesday -> cardio
  const ex = prescribedExercises(plan.workout);
  assert.ok(ex.every((e) => !e.loggable), "cardio day has no strength sets to log");
}

// Dead bug "2×10/side" parses (trailing /side ignored).
{
  const ex = prescribedExercises({ items: ["Dead bug 2×10/side"] });
  assert.equal(ex[0].sets, 2);
  assert.equal(ex[0].reps, 10);
  assert.equal(ex[0].muscle, "core");
}

console.log("plan-exercises.test.mjs: all assertions passed");
