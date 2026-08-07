import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  joinTranscript, collapseStutter, SPEECH_ERROR_COPY,
  dictationOutcome, createDictationController,
} from "../src/services/speech.js";

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

// ---------------------------------------------------------------------------
// "WHEN I PRESS ON STOP, NOTHING HAPPENS."
//
// The owner's report about the Home capture box, and it was literally true. The
// old flow reported the result of a recording by pushing one line into
// `state.parseLog`, which renders inside `<details class="capture-meta">` -
// closed by default. Measured on the real signed-in app: after Stop,
// #captureText was "", there was no toast, #agentDetail was unchanged and the
// <details> was shut. Stop was a visible no-op by construction.
//
// dictationOutcome is the fix's load-bearing half: EVERY branch returns a
// non-empty sentence, so a caller that renders `message` cannot render nothing.
// ---------------------------------------------------------------------------
{
  const cases = [
    { input: { transcript: "6 boiled eggs and 500ml curd" }, kind: "heard", ok: true },
    { input: { transcript: "", recordedBytes: 48_000 }, kind: "recorded", ok: true },
    { input: { transcript: "", error: "Microphone is blocked." }, kind: "error", ok: false },
    { input: { transcript: "", supported: false }, kind: "unsupported", ok: false },
    { input: {}, kind: "empty", ok: false },
    { input: undefined, kind: "empty", ok: false },
  ];
  for (const c of cases) {
    const out = dictationOutcome(c.input);
    assert.equal(out.kind, c.kind, `kind for ${JSON.stringify(c.input)}`);
    assert.equal(out.ok, c.ok, `ok for ${JSON.stringify(c.input)}`);
    assert.ok(typeof out.message === "string" && out.message.trim().length > 0,
      `EVERY stop says something - ${c.kind} produced no message`);
    assert.ok(!/[–—]/.test(out.message), `no em or en dashes: ${c.kind}`);
  }

  // The transcript wins over a recording of the same words: showing "recorded"
  // when there is text on screen would read as if the text had not been kept.
  assert.equal(dictationOutcome({ transcript: "dal chawal", recordedBytes: 9999 }).kind, "heard");

  // The message quotes what was actually heard, so "did it get my words?" is
  // answerable without squinting at the box.
  assert.match(dictationOutcome({ transcript: "paid 240 zomato" }).message, /paid 240 zomato/);

  // A staircase is collapsed before it is shown or returned - the outcome text
  // is what gets submitted as evidence.
  assert.equal(dictationOutcome({ transcript: REAL }).text, "I went to the gym today");

  // A long transcript is truncated for display but never in `text`.
  const long = "a ".repeat(120).trim();
  const outLong = dictationOutcome({ transcript: long });
  assert.ok(outLong.message.length < 140, "the status line stays one line");
  assert.ok(outLong.text.length > 0);

  // An error reports the REASON, never a bare "voice failed".
  assert.match(dictationOutcome({ error: "Microphone is blocked." }).message, /Microphone is blocked/);
}

// ---------------------------------------------------------------------------
// createDictationController - the ONE tap-to-talk implementation, now shared by
// the Home capture box and the Gym panel. It used to be two: Gym wrote the
// transcript into its textarea (which felt instant) and Home wrote it into
// state.activeJob.detail (which is invisible). Driven here with a fake engine,
// so the whole state machine is testable with no browser.
// ---------------------------------------------------------------------------
function fakeEngine() {
  let opts = null;
  let stopped = false;
  let aborted = false;
  const engine = (o) => {
    if (engine.refuse) return null;
    opts = o;
    stopped = false;
    return {
      stop() { stopped = true; },
      abort() { aborted = true; stopped = true; },
      getText: () => engine.text,
      isActive: () => !stopped,
    };
  };
  engine.text = "";
  engine.refuse = false;
  engine.say = (text) => { engine.text = text; opts.onUpdate({ text }); };
  engine.fail = (code, info) => opts.onError(code, info);
  engine.move = (state) => opts.onStateChange(state);
  engine.wasStopped = () => stopped;
  engine.wasAborted = () => aborted;
  engine.lang = () => opts?.lang;
  return engine;
}

function harness(overrides = {}) {
  const engine = fakeEngine();
  const notices = [];
  const states = [];
  let box = overrides.box ?? "";
  const controller = createDictationController({
    getBaseText: () => box,
    onText: (t) => { box = t; },
    onState: (s, info) => states.push([s, info?.kind || null]),
    onNotice: (m, info) => notices.push([m, info]),
    start: engine,
    supported: () => !engine.refuse,
    ...overrides.opts,
  });
  return { engine, notices, states, controller, read: () => box };
}

{
  // Live text lands in the box while speaking, as a REPLACE.
  const h = harness();
  assert.equal(h.controller.start(), true);
  assert.equal(h.controller.isListening(), true);
  h.engine.say("I went");
  assert.equal(h.read(), "I went");
  h.engine.say("I went to the gym");
  assert.equal(h.read(), "I went to the gym", "each update replaces, never appends");

  const outcome = await h.controller.stop({ settleMs: 0 });
  assert.equal(h.engine.wasStopped(), true);
  assert.equal(outcome.kind, "heard");
  assert.equal(outcome.text, "I went to the gym");
  assert.equal(h.controller.isListening(), false);
  // Exactly one sentence on stop, and it is the outcome's.
  assert.equal(h.notices.at(-1)[0], outcome.message);
  assert.ok(h.states.some(([s]) => s === "stopped"));
}

{
  // Anything already typed survives, and speech is appended to it.
  const h = harness({ box: "6 boiled eggs" });
  h.controller.start();
  h.engine.say("and 500ml curd");
  assert.equal(h.read(), "6 boiled eggs and 500ml curd");
  const out = await h.controller.stop({ settleMs: 0 });
  assert.equal(out.text, "and 500ml curd", "the outcome is what was SPOKEN, not the whole box");
}

{
  // THE REGRESSION THAT MATTERS. Speak nothing, press stop: there must still be
  // a sentence. This is the exact shape of "nothing happens".
  const h = harness();
  h.controller.start();
  const out = await h.controller.stop({ settleMs: 0 });
  assert.equal(out.kind, "empty");
  assert.equal(h.notices.length, 1, "stopping with no speech still says something");
  assert.match(h.notices[0][0], /Nothing was picked up/);
}

{
  // A recording exists but there was no live text: say the audio was kept
  // rather than implying the whole thing failed.
  const h = harness();
  h.controller.start();
  const out = await h.controller.stop({ settleMs: 0, recordedBytes: 12_345 });
  assert.equal(out.kind, "recorded");
  assert.match(h.notices.at(-1)[0], /transcribed/);
}

{
  // A FATAL engine error ends the session, is reported once, and is marked fatal
  // so the caller can also shout it (toast) rather than only tint a line.
  const h = harness();
  h.controller.start();
  h.engine.fail("not-allowed", { fatal: true, message: SPEECH_ERROR_COPY["not-allowed"] });
  assert.equal(h.controller.isListening(), false);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0][1].fatal, true);
  assert.match(h.notices[0][0], /Microphone is blocked/);
}

{
  // A NON-fatal error is still said out loud. The old code pushed these into the
  // collapsed parse log, which is why "live text needs internet" was never seen.
  const h = harness();
  h.controller.start();
  h.engine.fail("network", { fatal: false, message: SPEECH_ERROR_COPY.network });
  assert.equal(h.controller.isListening(), true, "a network blip does not end the session");
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0][1].fatal, false);
  assert.match(h.notices[0][0], /still recording/i);
}

{
  // No engine at all: start() refuses AND explains. Returning false silently is
  // the same disease with a boolean on it.
  const h = harness();
  h.engine.refuse = true;
  assert.equal(h.controller.start(), false);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0][0], /no speech recognition/i);
  assert.equal(h.notices[0][1].fatal, true);
}

{
  // A trailing final result that arrives during the settle window is picked up
  // rather than lost - Web Speech flushes inside onend, and the native Android
  // recogniser delivers onResults after stopListening() has already returned.
  const h = harness();
  h.controller.start();
  h.engine.say("dal");
  h.engine.text = "dal chawal and one samosa"; // the flush, not yet emitted
  const out = await h.controller.stop({ settleMs: 0 });
  assert.equal(out.text, "dal chawal and one samosa");
  assert.equal(h.read(), "dal chawal and one samosa", "the box is repainted with the flushed text");
}

{
  // The staircase guard is inside the controller too, so the box never shows it.
  const h = harness();
  h.controller.start();
  h.engine.say(REAL);
  assert.equal(h.read(), "I went to the gym today");
  assert.equal(h.controller.transcript(), "I went to the gym today");
}

{
  // Stopping twice is not an error and does not double-report.
  const h = harness();
  h.controller.start();
  h.engine.say("gym");
  await h.controller.stop({ settleMs: 0 });
  const before = h.notices.length;
  const again = await h.controller.stop({ settleMs: 0 });
  assert.equal(again.kind, "heard");
  assert.equal(h.notices.length, before, "a second stop says nothing new");
}

// ---------------------------------------------------------------------------
// STRUCTURAL: the two surfaces share the controller, and the capture page has a
// visible place to put what it says. A perfect controller wired into a
// collapsed <details> would pass every test above and still be invisible.
// ---------------------------------------------------------------------------
{
  const capture = readFileSync("src/ui/capture-panel.js", "utf8");
  const gym = readFileSync("src/ui/gym-today.js", "utf8");
  const html = readFileSync("index.html", "utf8");

  for (const [name, src] of [["capture-panel", capture], ["gym-today", gym]]) {
    assert.match(src, /createDictationController/, `${name} must use the shared dictation controller`);
    assert.ok(!/startLiveTranscription|startDictation\(/.test(src),
      `${name} must not keep a second hand-rolled dictation implementation`);
  }

  assert.match(html, /id="voiceStatus"[^>]*aria-live="polite"/,
    "index.html needs a live region for what voice just did");
  assert.match(html, /id="captureAttachments"[^>]*aria-live="polite"/,
    "index.html needs a live region for attachment upload state");
  // Both must sit OUTSIDE the collapsed AI-activity disclosure, which is where
  // this information used to die.
  const details = html.indexOf('<details class="capture-meta">');
  assert.ok(details > html.indexOf('id="voiceStatus"'), "#voiceStatus must be above the collapsed AI activity panel");
  assert.ok(details > html.indexOf('id="captureAttachments"'), "#captureAttachments must be above the collapsed AI activity panel");

  // Stopping voice writes to that region, not only to the parse log.
  assert.match(capture, /setVoiceStatus\(/, "capture-panel must write to #voiceStatus");
  assert.match(capture, /function finalizeVoice/, "capture-panel still owns one stop path");

  // Live text and a recording of the same sentence are the SAME evidence.
  // Uploading both doubles the extraction cost and hands the model the meal
  // twice, which is how one capture becomes two rows.
  assert.match(capture, /if \(outcome\.text && lastRecordingFile\)[\s\S]{0,200}pendingMediaFiles = pendingMediaFiles\.filter/,
    "when live text succeeded, the duplicate audio recording is dropped before upload");

  // The recogniser must never have to fight the app for the microphone on
  // Android, where the two live in different processes.
  assert.match(capture, /recorderMayRunAlongsideDictation/,
    "the recorder is gated on whether it can share the mic with the recogniser");
  assert.match(capture, /isNativePlatform/,
    "and that gate keys on the native platform, where the recogniser is another app");
}

console.log("speech transcript tests passed");
