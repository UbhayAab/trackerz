// Negation guard. Every "denied" case below is a REAL capture pulled from the
// production DB that wrongly created a workout_logs row (see the audit in
// docs/AUDIT-2026-07-22.md); the "affirmative" cases are the regressions those
// fixes must not cause.
import assert from "node:assert/strict";
import { isEventDenied, declaresNoWorkout, clauseDeniesEvent, clauseIsReportedSpeech, splitNegationClauses } from "../lib/negation.mjs";
import { looksLikeGym } from "../lib/capture-intent.mjs";
import { looksLikeFood } from "../lib/fan-out-expander.mjs";

// A gym mention test matching the widest cue set the pipeline uses (the edge
// function's GYM_CUE also fires on a bare "workout").
const mentionsGym = (t) => looksLikeGym(t) || /\bwork\s?out\b/i.test(t);

// ---- real production captures that must NOT create a workout ----
const DENIED_GYM = [
  "No gym today,",
  "Did not go to gym bro",
  "Did not go to gym today",
  "GOING TO NAGPUR TOMORROW AND DAY AFTER, CALS AND GYM OUT THRE WINDOW, NO GYM TODAY EITHER, OUT ON MON AND TUE, WHIC IS TOMOTTOW",
  "I did not do my workout yesterday, In the ai note here, it says I did workout, wth",
  "skipped the gym today",
  "no workout today",
  "couldn't make it to the gym",
  "missed my session",
  "bunked gym",
  "didn't do any training today",
  "no gym, too tired",
];

for (const text of DENIED_GYM) {
  assert.equal(isEventDenied(text, mentionsGym), true, `should be denied: ${text}`);
  assert.equal(declaresNoWorkout(text, mentionsGym), true, `declaresNoWorkout: ${text}`);
}

// "rest day" / "day off" announce a non-workout without naming the gym, so they
// are not a *denied gym mention* — but they do declare no workout.
for (const text of ["rest day today", "taking rest today", "day off from training"]) {
  assert.equal(declaresNoWorkout(text, mentionsGym), true, `declaresNoWorkout: ${text}`);
}

// ---- must STILL log ----
const AFFIRMATIVE_GYM = [
  "Walked 10k step, no gym",              // the walk is real exercise
  "in gym, just doing cardio today",
  "did workout A, bench 3x10 60kg",
  "hit the gym, legs day",
  "ran 5k this morning",
  "squat 4x8 80kg then deadlift 3x5",
  "no gym yesterday but hit the gym today", // "but" splits; the later clause wins
];

// Known limitation, asserted so it stays deliberate: when the affirmative clause
// elides the subject ("no gym yesterday but went today") there is no gym cue left
// in it, so the capture reads as denied. That errs toward NOT inventing a
// workout, which is the failure mode this guard exists to prevent — the user can
// still tap the Gym ✓ button.
assert.equal(isEventDenied("no gym yesterday but went today", mentionsGym), true);

for (const text of AFFIRMATIVE_GYM) {
  assert.equal(isEventDenied(text, mentionsGym), false, `should NOT be denied: ${text}`);
  assert.equal(declaresNoWorkout(text, mentionsGym), false, `declaresNoWorkout false: ${text}`);
}

// ---- food negation, and the false positives it must avoid ----
const DENIED_FOOD = [
  "skipped lunch today",
  "did not eat any lunch today",
  "no dinner tonight",
  "forgot to eat breakfast",
  "didn't have lunch",
];
for (const text of DENIED_FOOD) {
  assert.equal(isEventDenied(text, looksLikeFood), true, `food should be denied: ${text}`);
}

const AFFIRMATIVE_FOOD = [
  "ate rice with no salt",                // "no salt" is an ingredient, not a denial
  "coffee with no sugar",
  "6 boiled eggs",
  "had dal and 2 rotis",
  "Greek yogurt with blueberries and sugar",
  "skipped the gym but ate 6 boiled eggs", // gym denied, food affirmative
];
for (const text of AFFIRMATIVE_FOOD) {
  assert.equal(isEventDenied(text, looksLikeFood), false, `food should NOT be denied: ${text}`);
}

// Cross-domain independence on one mixed capture.
const mixed = "no gym today but ate 6 boiled eggs";
assert.equal(isEventDenied(mixed, mentionsGym), true, "mixed: gym denied");
assert.equal(isEventDenied(mixed, looksLikeFood), false, "mixed: food kept");

// ---- unit behaviour ----
assert.equal(clauseDeniesEvent("no gym"), true);
assert.equal(clauseDeniesEvent("with no sugar"), false);
assert.equal(clauseIsReportedSpeech("it says I did workout"), true);
assert.equal(clauseIsReportedSpeech("I did workout"), false);
assert.deepEqual(splitNegationClauses("a, b; c"), ["a", "b", "c"]);
assert.equal(isEventDenied("", mentionsGym), false);

// An empty / non-matching capture is never "denied".
assert.equal(isEventDenied("paid 240 zomato", mentionsGym), false);

console.log("negation.test.mjs OK");
