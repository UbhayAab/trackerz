import assert from "node:assert/strict";
import { joinTranscript, collapseStutter, SPEECH_ERROR_COPY } from "../src/services/speech.js";

// ---------------------------------------------------------------------------
// THE 2026-08-06 STUTTER.
//
// A single spoken sentence - "I went to the gym today", said once - reached
// raw_ingestions as a staircase of its own growing prefixes. Every prefix
// appears exactly once, which is the signature of appending successive
// CUMULATIVE hypotheses rather than replacing with the latest one.
//
// The old wrapper kept `let aggregate = ""` outside the result handler and did
// `aggregate += finalChunk`. `event.results` is a live, mutable list: the spec
// lets any entry be revised, and Chrome on Android re-delivers a growing prefix
// after each internal restart. A buffer that outlives the event cannot
// un-append the version it already took.
// ---------------------------------------------------------------------------
const REAL = "I I went I went I went to I went to the I went to the gym I went to the gym today I went to the gym today";

{
  assert.equal(collapseStutter(REAL), "I went to the gym today",
    "the real logged staircase collapses back to the sentence that was actually said");

  // Idempotent: safe to run on text that is already clean, because it also runs
  // server-side on evidence from transcription sources we do not control.
  assert.equal(collapseStutter("I went to the gym today"), "I went to the gym today");
  assert.equal(collapseStutter(collapseStutter(REAL)), collapseStutter(REAL));

  // Multi-word content that merely LOOKS repetitive survives intact - the runs
  // are not actually adjacent duplicates.
  assert.equal(collapseStutter("2 rotis and 2 rotis more"), "2 rotis and 2 rotis more",
    "a repeated phrase separated by other words is not a stutter run");
  assert.equal(collapseStutter("6 boiled eggs and 500ml curd"), "6 boiled eggs and 500ml curd");
  assert.equal(collapseStutter(""), "");
  assert.equal(collapseStutter("gym"), "gym");

  // ACCEPTED TRADEOFF, asserted so it is a decision and not a surprise: an
  // adjacent doubled word is normalised. Costs nothing in a food/gym log, and
  // the alternative is letting the staircase through - the whole string becomes
  // evidence for the agent, and that is what fabricated a 540 kcal meal.
  assert.equal(collapseStutter("very very good"), "very good",
    "an adjacent doubled word is treated as a stutter - deliberate");
}

// ---------------------------------------------------------------------------
// joinTranscript: the guard that stops the staircase forming in the first place.
// ---------------------------------------------------------------------------
{
  // A longer revision of what we already have REPLACES it.
  assert.equal(joinTranscript("I went", "I went to the gym"), "I went to the gym");
  assert.equal(joinTranscript("I", "I went"), "I went");

  // A re-delivery of what we already have is a no-op.
  assert.equal(joinTranscript("I went to the gym", "went to the gym"), "I went to the gym");
  assert.equal(joinTranscript("I went to the gym", "I went to the gym"), "I went to the gym");

  // A genuine continuation is appended with exactly one space.
  assert.equal(joinTranscript("I went to the gym", "and had eggs"), "I went to the gym and had eggs");

  // Partial overlap at the seam, which is what an Android session restart emits.
  assert.equal(joinTranscript("I went to the", "the gym today"), "I went to the gym today");

  // Empty operands.
  assert.equal(joinTranscript("", "6 eggs"), "6 eggs");
  assert.equal(joinTranscript("6 eggs", ""), "6 eggs");
  assert.equal(joinTranscript("", ""), "");

  // Case-insensitive matching, original casing preserved.
  assert.equal(joinTranscript("I Went", "i went to the gym"), "i went to the gym");

  // Word-boundary matching, not character. A character-level overlap check
  // fuses these into "I went to thethe gym today".
  assert.equal(joinTranscript("I went to the", "the gym today"), "I went to the gym today");
  assert.ok(!joinTranscript("I went to the", "the gym today").includes("thethe"));

  // No shared words at all: plain append with exactly one space.
  assert.equal(joinTranscript("dal chawal", "one samosa"), "dal chawal one samosa");
}

// ---------------------------------------------------------------------------
// Replaying the exact event stream that produced the bug.
//
// This is the regression that matters: feed the same sequence of cumulative
// results through the same fold the wrapper now uses, and assert the staircase
// cannot form. The old `aggregate += transcript` is shown alongside so the
// difference is visible in the test output rather than only in prose.
// ---------------------------------------------------------------------------
{
  // Reconstructed from the logged string by splitting on each restart of the
  // prefix. Note "I went" and the full sentence each appear TWICE: the
  // recognizer re-emits a stabilised hypothesis unchanged, which the old
  // `aggregate +=` fold appended a second time.
  const CUMULATIVE = [
    "I", "I went", "I went", "I went to", "I went to the",
    "I went to the gym", "I went to the gym today", "I went to the gym today",
  ];

  // What the old code did.
  let broken = "";
  for (const chunk of CUMULATIVE) broken += `${chunk} `;
  assert.equal(broken.trim(), REAL, "the old fold reproduces the exact logged string");

  // What the new fold does.
  let fixed = "";
  for (const chunk of CUMULATIVE) fixed = joinTranscript(fixed, chunk);
  assert.equal(fixed, "I went to the gym today",
    "the overlap-aware fold yields the sentence that was actually spoken");

  // And a session restart mid-utterance, where results reset to index 0 and the
  // provider re-sends the whole utterance so far.
  let acrossRestart = "";
  for (const chunk of ["I went to the", "I went to the gym", "I went to the gym today"]) {
    acrossRestart = joinTranscript(acrossRestart, chunk);
  }
  assert.equal(acrossRestart, "I went to the gym today");
}

// ---------------------------------------------------------------------------
// Error copy: every code the spec can emit has a human sentence, and the two
// non-fatal ones say the recording survives - because it does. Killing the
// session on `network` would throw away audio that Gemini can still transcribe.
// ---------------------------------------------------------------------------
{
  for (const code of ["no-speech", "audio-capture", "not-allowed", "service-not-allowed", "network", "language-not-supported", "bad-grammar"]) {
    assert.ok(typeof SPEECH_ERROR_COPY[code] === "string" && SPEECH_ERROR_COPY[code].length > 0,
      `every spec error code has user-facing copy: ${code}`);
    assert.ok(!/[–—]/.test(SPEECH_ERROR_COPY[code]), `no en/em dashes in copy: ${code}`);
  }
  assert.equal(SPEECH_ERROR_COPY.aborted, null, "an abort we caused says nothing");
  assert.match(SPEECH_ERROR_COPY.network, /still recording/i,
    "a network failure must tell the user the audio is still being captured");
}

console.log("speech transcript tests passed");
