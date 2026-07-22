import assert from "node:assert/strict";
import {
  looksLikeGym, parseExercises, GYM_WORDS, CARDIO_WORDS, SET_REP_RE, WEIGHT_RE,
} from "../lib/capture-intent.mjs";

// ---------------------------------------------------------------------------
// exported lexicons + regexes (one source of truth shared with the index.ts mirror)
// ---------------------------------------------------------------------------
for (const [name, lex] of Object.entries({ GYM_WORDS, CARDIO_WORDS })) {
  assert.ok(Array.isArray(lex) && lex.length > 0 && lex.every((w) => typeof w === "string"), `${name} ok`);
}
assert.ok(SET_REP_RE instanceof RegExp && WEIGHT_RE instanceof RegExp);

// ---------------------------------------------------------------------------
// looksLikeGym - workout free text, even without the word "gym"
// ---------------------------------------------------------------------------
assert.ok(looksLikeGym("I just did Workout A"));
assert.ok(looksLikeGym("did legs"));
assert.ok(looksLikeGym("did chest and back"));
assert.ok(looksLikeGym("worked out today"));
assert.ok(looksLikeGym("bench 3x10 60kg"));
assert.ok(looksLikeGym("squat 60kg 3x8"));
assert.ok(looksLikeGym("3x12"), "bare set×rep pattern is a workout");
assert.ok(looksLikeGym("ran 5k"));
assert.ok(looksLikeGym("walked 35 min"));
assert.ok(looksLikeGym("brisk walk"));
assert.ok(looksLikeGym("10k steps today"));
assert.ok(!looksLikeGym(""));
assert.ok(!looksLikeGym("had dal and rotis"));
assert.ok(!looksLikeGym("grocery run at the bakery"), "grocery run is not cardio");
assert.ok(!looksLikeGym("need to run an errand"), "errand run is not cardio");

// ---------------------------------------------------------------------------
// parseExercises - best-effort set×rep×weight, never invents reps/sets
// ---------------------------------------------------------------------------
assert.deepEqual(parseExercises("bench 3x10 60kg"), [
  { exercise: "bench", sets: 3, reps: 10, weight_kg: 60 },
]);
assert.deepEqual(parseExercises("squat 60kg 3x8"), [
  { exercise: "squat", sets: 3, reps: 8, weight_kg: 60 },
]);
assert.deepEqual(parseExercises("squat 60kg 3x8, then leg press 2x12"), [
  { exercise: "squat", sets: 3, reps: 8, weight_kg: 60 },
  { exercise: "leg press", sets: 2, reps: 12, weight_kg: null },
]);
assert.deepEqual(parseExercises("plank 3x30s"), [
  { exercise: "plank", sets: 3, reps: 30, weight_kg: null },
]);
assert.deepEqual(parseExercises("did deadlift 5x5 100kg"), [
  { exercise: "deadlift", sets: 5, reps: 5, weight_kg: 100 },
]);
assert.deepEqual(parseExercises("ohp 3×12 30kg"), [
  { exercise: "ohp", sets: 3, reps: 12, weight_kg: 30 },
]);
assert.deepEqual(parseExercises("I just did Workout A"), []);
assert.deepEqual(parseExercises("ran 5k"), []);
assert.deepEqual(parseExercises("walked 35 min"), []);
assert.deepEqual(parseExercises(""), []);

console.log("capture-intent (gym detection) tests passed");
