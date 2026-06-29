// Gym auto-check: a captured workout's logged sets tick the matching prescribed
// exercises, muscle-gated so different lifts don't cross-tick.
import assert from "node:assert/strict";
import { reconcileExercises } from "../src/domain/diet/reconcile.js";
import { prescribedExercises } from "../src/domain/diet/plan.js";

const DATE = new Date(2026, 6, 6); // local July 6
const at = "2026-07-06T18:00:00";  // same local day (no Z -> local parse)

const workout = {
  items: [
    "Leg press 2×12",          // ex0 quads
    "Machine chest press 2×10",// ex1 chest
    "Lat pulldown 2×10",       // ex2 back
    "Incline DB press 2×10",   // ex3 chest
    "Treadmill 8 min easy",    // note (not loggable)
  ],
};
// sanity on the keying we rely on
const pres = prescribedExercises(workout);
assert.equal(pres[0].key, "ex0");
assert.equal(pres[0].muscle, "quads");

const log = (sets) => [{ id: "w1", occurred_at: at, sets }];

// exact match -> auto on its key, nothing else
{
  const r = reconcileExercises(workout, log([{ exercise: "Leg press", muscle: "quads", reps: 12, weight_kg: 80, done: true }]), DATE);
  assert.equal(r.ex0?.source, "auto", "leg press auto-ticks ex0");
  assert.equal(r.ex0.recordId, "w1");
  assert.ok(!r.ex1 && !r.ex2 && !r.ex3, "a leg-press log ticks ONLY the leg press");
}

// same family (chest press) -> chest exercise auto; partial overlap (incline db press) -> suggested
{
  const r = reconcileExercises(workout, log([{ exercise: "chest press", muscle: "chest", reps: 10, weight_kg: 40, done: true }]), DATE);
  assert.equal(r.ex1?.source, "auto", "'chest press' covers 'Machine chest press' name -> auto");
  assert.equal(r.ex3?.source, "suggested", "'chest press' only partially covers 'Incline DB press' -> suggested");
  assert.ok(!r.ex0 && !r.ex2, "no quads/back tick from a chest log");
}

// muscle gate: a hamstrings lift never ticks a quads exercise
{
  const r = reconcileExercises(workout, log([{ exercise: "leg curl", muscle: "hamstrings", reps: 12, weight_kg: 30, done: true }]), DATE);
  assert.deepEqual(r, {}, "leg curl (hamstrings) ticks nothing in this quad/chest/back workout");
}

// multiple logged sets across exercises
{
  const r = reconcileExercises(workout, log([
    { exercise: "Leg press", muscle: "quads", reps: 12, weight_kg: 85 },
    { exercise: "Lat pulldown", muscle: "back", reps: 10, weight_kg: 45 },
  ]), DATE);
  assert.equal(r.ex0?.source, "auto");
  assert.equal(r.ex2?.source, "auto");
}

// off-date logs are ignored
{
  const r = reconcileExercises(workout, [{ id: "w2", occurred_at: "2026-07-01T18:00:00", sets: [{ exercise: "Leg press", muscle: "quads" }] }], DATE);
  assert.deepEqual(r, {}, "a workout on a different day does not tick today");
}

// empty / missing
assert.deepEqual(reconcileExercises(workout, [], DATE), {});
assert.deepEqual(reconcileExercises({ items: [] }, log([{ exercise: "Leg press", muscle: "quads" }]), DATE), {});

console.log("reconcile-gym tests passed");
