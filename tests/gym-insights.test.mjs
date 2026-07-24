// gym-insights engine: every claim traces to real rows; thin evidence returns
// an explicit "not enough data" signal, never a fabricated 0/trend.

import assert from "node:assert";
import { computeGymInsights } from "../lib/gym-insights.mjs";

// Fixed "now": Thu 2026-07-23 12:00 IST (06:30Z). ISO week starts Mon 2026-07-20.
const NOW = new Date("2026-07-23T06:30:00Z");

function log(dateIST, status = "done", extra = {}) {
  // dateIST like "2026-07-21T10:00:00+05:30"
  return { id: Math.random().toString(36).slice(2), occurred_at: dateIST, status, ...extra };
}

// --- empty dataset: honest nulls, no invented numbers -----------------------
{
  const out = computeGymInsights({ workoutLogs: [], bodyMetrics: [], budgets: [], now: NOW });
  assert.equal(out.consistency.hasData, false, "no data flagged");
  assert.equal(out.consistency.doneThisWeek, 0, "zero real done days is a counted 0, allowed (rows searched)");
  assert.equal(out.consistency.streakWeeks, 0);
  assert.equal(out.consistency.target, 4, "seed weekly target when unset");
  assert.equal(out.progression.hasSets, false);
  assert.match(out.progression.message, /Start logging your sets/);
  assert.equal(out.bodyweight.hasData, false);
  assert.match(out.bodyweight.message, /Add a weight/);
  assert.equal(out.muscleBalance.hasData, false);
  assert.equal(out.restPattern.hasData, false);
}

// --- DISTINCT days: one gym trip logged twice is one session ----------------
{
  const logs = [
    log("2026-07-20T09:00:00+05:30"),
    log("2026-07-20T09:05:00+05:30"), // duplicate same civil day
    log("2026-07-22T18:00:00+05:30"),
  ];
  const out = computeGymInsights({ workoutLogs: logs, now: NOW });
  assert.equal(out.consistency.doneThisWeek, 2, "two distinct days, not three rows");
}

// --- weekly target met + current-week streak counts ------------------------
{
  const logs = [
    log("2026-07-20T09:00:00+05:30"),
    log("2026-07-21T09:00:00+05:30"),
    log("2026-07-22T09:00:00+05:30"),
    log("2026-07-23T09:00:00+05:30"),
  ];
  const out = computeGymInsights({ workoutLogs: logs, budgets: [{ kind: "weekly_workouts", amount: 4 }], now: NOW });
  assert.equal(out.consistency.doneThisWeek, 4);
  assert.equal(out.consistency.metThisWeek, true);
  assert.equal(out.consistency.streakWeeks, 1, "current week active -> streak 1");
  assert.equal(out.consistency.weeks.length, 8, "8-week bar series");
  assert.equal(out.consistency.weeks[7].isCurrent, true);
  assert.equal(out.consistency.weeks[7].doneDays, 4);
}

// --- streak survives an untrained current week (grace) ----------------------
{
  // active last two weeks, nothing yet this week
  const logs = [
    log("2026-07-13T09:00:00+05:30"), // week of Jul 13
    log("2026-07-06T09:00:00+05:30"), // week of Jul 06
  ];
  const out = computeGymInsights({ workoutLogs: logs, now: NOW });
  assert.equal(out.consistency.doneThisWeek, 0, "nothing this week yet");
  assert.equal(out.consistency.streakWeeks, 2, "two prior active weeks still count");
}

// --- progression: real weighted sets trend up -------------------------------
{
  const logs = [
    log("2026-07-06T09:00:00+05:30", "done", { sets: [{ exercise: "Bench Press", muscle: "chest", weight_kg: 40, reps: 8 }] }),
    log("2026-07-13T09:00:00+05:30", "done", { sets: [{ exercise: "Bench Press", muscle: "chest", weight_kg: 45, reps: 8 }] }),
    log("2026-07-20T09:00:00+05:30", "done", { sets: [{ exercise: "Bench Press", muscle: "chest", weight_kg: 47.5, reps: 6 }] }),
  ];
  const out = computeGymInsights({ workoutLogs: logs, now: NOW });
  assert.equal(out.progression.hasSets, true);
  const bench = out.progression.exercises.find((e) => e.exercise === "Bench Press");
  assert.ok(bench, "bench tracked");
  assert.equal(bench.trend, "up");
  assert.equal(bench.top, 47.5, "top weight is the real max");
  assert.equal(bench.sessions, 3);
  // muscle balance derives from the same real sets
  assert.equal(out.muscleBalance.hasData, true);
  assert.equal(out.muscleBalance.groups[0].muscle, "chest");
  assert.equal(out.muscleBalance.groups[0].sets, 3);
}

// --- progression: empty sets arrays never fabricate a lift ------------------
{
  const logs = [
    log("2026-07-20T09:00:00+05:30", "done", { sets: [] }),
    log("2026-07-22T09:00:00+05:30", "done", { sets: [{ exercise: "Squat", reps: 10 }] }), // no weight_kg
  ];
  const out = computeGymInsights({ workoutLogs: logs, now: NOW });
  assert.equal(out.progression.hasSets, false, "sets without weight_kg do not count");
  assert.equal(out.progression.exercises.length, 0, "no invented lifts");
  assert.match(out.progression.message, /unlock progression tracking/);
}

// --- bodyweight: >=2 points -> real delta -----------------------------------
{
  const bm = [
    { metric_type: "weight", value: 74, occurred_at: "2026-07-01T06:00:00+05:30" },
    { metric_type: "weight", value: 72.5, occurred_at: "2026-07-22T06:00:00+05:30" },
    { metric_type: "steps", value: 0, occurred_at: "2026-07-22T06:00:00+05:30" }, // ignored
  ];
  const out = computeGymInsights({ workoutLogs: [], bodyMetrics: bm, now: NOW });
  assert.equal(out.bodyweight.hasData, true);
  assert.equal(out.bodyweight.points.length, 2, "only weight rows, steps ignored");
  assert.equal(out.bodyweight.latest, 72.5);
  assert.equal(out.bodyweight.delta, -1.5);
  assert.equal(out.bodyweight.direction, "down");
}

// --- bodyweight: single point is a point, not a line ------------------------
{
  const bm = [{ metric_type: "weight", value: 73, occurred_at: "2026-07-10T06:00:00+05:30" }];
  const out = computeGymInsights({ bodyMetrics: bm, now: NOW });
  assert.equal(out.bodyweight.hasData, false);
  assert.equal(out.bodyweight.latest, 73);
  assert.match(out.bodyweight.message, /Add another weight/);
}

// --- rest / skip pattern within trailing 14 days ----------------------------
{
  const logs = [
    log("2026-07-22T09:00:00+05:30", "done"),
    log("2026-07-21T09:00:00+05:30", "skipped"),
    log("2026-07-20T09:00:00+05:30", "rest"),
    log("2026-05-01T09:00:00+05:30", "skipped"), // outside window, ignored
  ];
  const out = computeGymInsights({ workoutLogs: logs, now: NOW });
  assert.equal(out.restPattern.doneDays, 1);
  assert.equal(out.restPattern.skippedDays, 1);
  assert.equal(out.restPattern.restDays, 1);
  assert.equal(out.restPattern.hasData, true);
}

console.log("gym-insights.test.mjs: all assertions passed");
