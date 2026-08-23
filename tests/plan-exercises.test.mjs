// The gym tracker turns the day's workout into structured, loggable exercises.
//
// Since the program became the Home Protocol (lib/home-protocol.mjs) the
// scaffold days carry structured exercises already - sets, rep range, zone, cue,
// whether a dumbbell is involved - so prescribedExercises should PASS THOSE
// THROUGH rather than re-deriving them from a string. The free-text parser is
// still exercised here, because user plan overrides and one-off custom workouts
// arrive as `items` and must keep working.

import assert from "node:assert";
import { planForDate, prescribedExercises, muscleFor, weeklyWorkoutCount } from "../src/domain/diet/plan.js";
import { PROTOCOL_DAYS, LOAD_CEILING_KG, protocolWorkouts, exerciseLine } from "../lib/home-protocol.mjs";

// muscleFor keyword mapping. The second block is the home program: every one of
// these landed on "other" before the rules learned them, which meant the weekly
// volume-by-muscle chart silently binned most of a session.
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

  assert.equal(muscleFor("Bulgarian Split Squat"), "quads");
  assert.equal(muscleFor("DB Step-Ups"), "quads");
  assert.equal(muscleFor("DB Thrusters"), "quads");
  assert.equal(muscleFor("Single-Leg RDL"), "hamstrings");
  assert.equal(muscleFor("DB Good Mornings"), "hamstrings");
  assert.equal(muscleFor("DB Floor Press"), "chest");
  assert.equal(muscleFor("Deficit Push-ups"), "chest");
  assert.equal(muscleFor("Chin-ups"), "back");
  assert.equal(muscleFor("Renegade Row"), "back");
  assert.equal(muscleFor("Arnold Press"), "shoulders");
  assert.equal(muscleFor("Band Face Pulls"), "shoulders");
  assert.equal(muscleFor("Band Pull-Aparts"), "shoulders");
  assert.equal(muscleFor("Bent-Over Reverse Flyes"), "shoulders", "a reverse flye is rear delts, not chest");
  assert.equal(muscleFor("Skull Crushers"), "triceps");
  assert.equal(muscleFor("Overhead DB Extension"), "triceps", "an overhead extension is triceps, not an overhead press");
  assert.equal(muscleFor("Zottman Curl"), "biceps");
  assert.equal(muscleFor("Hanging Knee Raise"), "core");
  assert.equal(muscleFor("Leg Raises"), "core", "a leg raise is core; a lateral raise is not");
  assert.equal(muscleFor("Suitcase March"), "core");
  assert.equal(muscleFor("Single-Leg Calf Raise"), "calves");
  assert.equal(muscleFor("DB Hip Thrust"), "glutes");
}

// The rotation: six training days then rest, one calendar day to one letter.
{
  const letters = PROTOCOL_DAYS.map((d) => d.letter);
  assert.deepEqual(letters, ["A", "B", "C", "D", "E", "F", "R"]);

  const rest = PROTOCOL_DAYS.filter((d) => d.rest);
  assert.equal(rest.length, 1, "exactly one planned rest day");
  assert.equal(rest[0].letter, "R");

  // ONE heavy exposure per pattern is the whole reason six days a week is
  // survivable. A day that stacks four heavy lifts is a programming bug.
  for (const day of PROTOCOL_DAYS) {
    if (day.rest) continue;
    const heavy = day.exercises.filter((e) => e.zone === "heavy");
    assert.ok(heavy.length <= 2, `day ${day.letter} has ${heavy.length} heavy lifts`);
    assert.ok(day.exercises.length >= 5, `day ${day.letter} is too thin to be a session`);
    for (const e of day.exercises) {
      assert.ok(["heavy", "med", "pump", "core"].includes(e.zone), `${e.name} has an unknown zone`);
      assert.ok(e.cue, `${e.name} has no cue`);
    }
  }
}

// Day A (a Monday) resolves to the structured Home Protocol session.
{
  const plan = planForDate(new Date("2026-06-22T09:00:00+05:30")); // Monday -> Day A
  assert.equal(plan.workout.letter, "A");
  const ex = prescribedExercises(plan.workout);
  assert.equal(ex.length, 8, "all eight rows represented");

  const bench = ex.find((e) => /flat db bench/i.test(e.name));
  assert.ok(bench, "the heavy press is present");
  assert.equal(bench.sets, 4);
  assert.equal(bench.reps, 6, "logging a tick uses the bottom of the range");
  assert.equal(bench.repsLabel, "6-8", "the range itself survives for display");
  assert.equal(bench.zone, "heavy");
  assert.equal(bench.muscle, "chest");
  assert.equal(bench.load, true, "a dumbbell press takes load, so the ceiling gauge applies");
  assert.equal(bench.loggable, true);

  const pullups = ex.find((e) => /pull-ups/i.test(e.name));
  assert.equal(pullups.load, false, "bodyweight - no load input, but still logged");
  assert.equal(pullups.loggable, true);

  const split = ex.find((e) => /bulgarian/i.test(e.name));
  assert.equal(split.perSide, true, "10-12 per leg, not 10-12 total");

  assert.ok(ex.every((e) => e.cue), "every row carries its cue into the UI");
}

// Timed holds stay timed.
{
  const plan = planForDate(new Date("2026-06-23T09:00:00+05:30")); // Tuesday -> Day B
  assert.equal(plan.workout.letter, "B");
  const plank = prescribedExercises(plan.workout).find((e) => e.name === "Plank");
  assert.equal(plank.repsUnit, "sec");
  assert.equal(plank.reps, 45);
  assert.equal(plank.zone, "core");
}

// Sunday is the rest day: nothing to log, and it says why rather than showing an
// empty list.
{
  const plan = planForDate(new Date("2026-06-28T09:00:00+05:30")); // Sunday -> Day R
  assert.equal(plan.workout.letter, "R");
  assert.equal(plan.workout.rest, true);
  const ex = prescribedExercises(plan.workout);
  assert.ok(ex.length > 0, "the rest day still tells you what to do");
  assert.ok(ex.every((e) => !e.loggable), "but none of it is a strength set");
}

// The legacy `items` contract still holds: plan-merge, the morning brief and the
// diet page consume plain strings and must not have to know about zones.
{
  const workouts = protocolWorkouts();
  for (const w of Object.values(workouts)) {
    assert.ok(Array.isArray(w.items) && w.items.length, `${w.name} has no items`);
    assert.ok(w.items.every((i) => typeof i === "string"));
  }
  assert.equal(exerciseLine({ name: "Bulgarian Split Squat", sets: 3, repsLabel: "10-12", perSide: true }), "Bulgarian Split Squat 3x10-12 /side");
}

// The ceiling is a real number the UI can draw a wall at.
{
  assert.equal(LOAD_CEILING_KG, 25);
}

// Free-text overrides still parse: a custom workout arrives as items, with no
// structured exercises at all.
{
  const ex = prescribedExercises({ items: ["Dead bug 2×10/side"] });
  assert.equal(ex[0].sets, 2);
  assert.equal(ex[0].reps, 10);
  assert.equal(ex[0].muscle, "core");
  assert.equal(ex[0].perSide, true);

  const custom = prescribedExercises({ items: ["Leg press 2×12", "Treadmill 8 min easy"] });
  assert.equal(custom[0].sets, 2);
  assert.equal(custom[0].reps, 12);
  assert.equal(custom[0].muscle, "quads");
  assert.equal(custom[0].loggable, true);
  assert.equal(custom[1].kind, "note", "no S×R -> a note, not a strength set");
  assert.equal(custom[1].loggable, false);
}

// weeklyWorkoutCount: rolling 7-day window anchored on `todayISO`, not a
// calendar week -- feeds the "weekly_workouts" goal.
{
  const today = "2026-07-08T09:00:00+05:30"; // a Wednesday
  const logs = [
    { occurred_at: "2026-07-08T18:00:00+05:30" }, // today
    { occurred_at: "2026-07-06T18:00:00+05:30" }, // 2 days ago
    { occurred_at: "2026-07-02T18:00:00+05:30" }, // 6 days ago -> inside the window
    { occurred_at: "2026-07-01T18:00:00+05:30" }, // 7 days ago -> outside (window is today-6..today)
    { occurred_at: "2026-06-01T18:00:00+05:30" }, // long ago
  ];
  assert.equal(weeklyWorkoutCount(logs, today), 3, "counts only the trailing 7 days, inclusive of today");
  assert.equal(weeklyWorkoutCount([], today), 0, "no logs -> 0");
  assert.equal(weeklyWorkoutCount(undefined, today), 0, "missing logs array -> 0, not a throw");
  assert.equal(weeklyWorkoutCount([{ occurred_at: "not-a-date" }], today), 0, "unparseable date is ignored, not counted");

  // DAYS TRAINED, not rows. Ticking six exercises on the Gym page writes six rows
  // for one session and used to read as six workouts.
  const sixTicksOneDay = [
    { occurred_at: "2026-07-08T18:00:00+05:30", status: "done" },
    { occurred_at: "2026-07-08T18:05:00+05:30", status: "done" },
    { occurred_at: "2026-07-08T18:11:00+05:30", status: "done" },
    { occurred_at: "2026-07-08T18:20:00+05:30", status: "done" },
    { occurred_at: "2026-07-08T18:31:00+05:30", status: "done" },
    { occurred_at: "2026-07-08T18:40:00+05:30", status: "done" },
  ];
  assert.equal(weeklyWorkoutCount(sixTicksOneDay, today), 1, "one gym trip is one workout, however many rows it wrote");

  // A 'skipped' row is the user answering "no gym today". It must never raise the
  // count of workouts done - the live DB holds more skipped rows than done ones.
  const skips = [
    { occurred_at: "2026-07-08T18:00:00+05:30", status: "skipped" },
    { occurred_at: "2026-07-07T18:00:00+05:30", status: "skipped" },
    { occurred_at: "2026-07-06T18:00:00+05:30", status: "rest" },
  ];
  assert.equal(weeklyWorkoutCount(skips, today), 0, "'no gym today' is not a workout");
  assert.equal(
    weeklyWorkoutCount([...skips, { occurred_at: "2026-07-05T18:00:00+05:30", status: "done" }], today),
    1,
    "skipped rows are ignored while real sessions still count",
  );

  // Legacy rows written before the status column existed are real sessions.
  assert.equal(
    weeklyWorkoutCount([{ occurred_at: "2026-07-08T18:00:00+05:30" }], today),
    1,
    "null status means a logged session, not an unknown",
  );
}

console.log("plan-exercises.test.mjs: all assertions passed");
