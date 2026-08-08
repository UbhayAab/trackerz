import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GEMINI_AUDIO_MIME, normaliseAudioType, isGeminiAudioMime, plannedUpload, pickRecorderMime,
  formatBytes, describeUpload, describeRecording,
} from "../src/services/audio-convert.js";

// ---------------------------------------------------------------------------
// THE BUG THIS FILE EXISTS FOR.
//
// MediaRecorder's default container in Chrome is audio/webm. The Gemini API does
// not accept audio/webm at all. So every voice note uploaded fine, 400'd during
// extraction, was swallowed (`geminiEvidence = ""`), and the UI still said
// "Capture saved". In the browser Web Speech masked it by supplying a transcript
// anyway; in the Android app there is no Web Speech API, so voice was completely
// and silently dead.
// ---------------------------------------------------------------------------
{
  assert.equal(isGeminiAudioMime("audio/webm"), false, "the exact format we were uploading is NOT accepted");
  assert.equal(isGeminiAudioMime("audio/webm;codecs=opus"), false);
  assert.equal(isGeminiAudioMime("audio/wav"), true);
  assert.equal(isGeminiAudioMime("audio/ogg"), true);
  assert.equal(isGeminiAudioMime("audio/mp4"), false, "Safari's default is not on Gemini's list either");
  assert.equal(isGeminiAudioMime(""), false);
  assert.equal(isGeminiAudioMime(undefined), false);

  // Codec parameters must not defeat the check.
  assert.equal(normaliseAudioType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normaliseAudioType("AUDIO/WAV"), "audio/wav");
  assert.equal(normaliseAudioType(" audio/ogg ; codecs=opus "), "audio/ogg");
  assert.equal(normaliseAudioType(null), "");
}

// ---------------------------------------------------------------------------
// The decision, made in pure code so it is testable without an AudioContext.
// ---------------------------------------------------------------------------
{
  assert.equal(plannedUpload({ type: "audio/webm", size: 100000 }).action, "transcode");
  assert.equal(plannedUpload({ type: "audio/webm;codecs=opus", size: 100000 }).action, "transcode");
  assert.equal(plannedUpload({ type: "audio/mp4", size: 100000 }).action, "transcode",
    "Safari records mp4, which also has to be converted");
  assert.equal(plannedUpload({ type: "audio/wav", size: 100000 }).action, "upload");
  assert.equal(plannedUpload({ type: "audio/ogg", size: 100000 }).action, "upload");

  // Non-audio is none of this module's business.
  assert.equal(plannedUpload({ type: "image/jpeg", size: 100000 }).action, "upload");
  assert.equal(plannedUpload({ type: "application/pdf", size: 5000 }).action, "upload");
  assert.equal(plannedUpload({ type: "", size: 10 }).action, "upload");

  // A 30-minute recording is refused with a reason rather than uploaded and
  // timed out. Every branch returns a defined action - never undefined.
  const huge = plannedUpload({ type: "audio/webm", size: 40 * 1024 * 1024 });
  assert.equal(huge.action, "reject");
  assert.match(huge.reason, /\d+ MB/, "the refusal names the actual size and the limit");
  for (const t of ["audio/webm", "audio/wav", "image/png", ""]) {
    const p = plannedUpload({ type: t, size: 1000 });
    assert.ok(["upload", "transcode", "reject"].includes(p.action), `defined action for ${t}`);
    assert.ok(p.reason, `every decision carries a reason (${t})`);
  }
}

// ---------------------------------------------------------------------------
// Recorder selection. If the device can record straight into something the API
// accepts, skip the transcode entirely.
// ---------------------------------------------------------------------------
{
  const supports = (...ok) => ({ isTypeSupported: (m) => ok.includes(m) });

  assert.equal(pickRecorderMime(supports("audio/ogg;codecs=opus", "audio/webm")), "audio/ogg;codecs=opus",
    "prefer a container that needs no conversion");
  assert.equal(pickRecorderMime(supports("audio/webm;codecs=opus", "audio/webm")), "audio/webm;codecs=opus");
  assert.equal(pickRecorderMime(supports("audio/mp4")), "audio/mp4");
  assert.equal(pickRecorderMime(supports()), "", "nothing supported: let MediaRecorder choose its default");
  assert.equal(pickRecorderMime(undefined), "", "no MediaRecorder at all must not throw");
  assert.equal(pickRecorderMime({}), "");

  // Whatever it picks must be something MediaRecorder said yes to.
  const dev = supports("audio/webm", "audio/mp4");
  const picked = pickRecorderMime(dev);
  assert.ok(picked === "" || dev.isTypeSupported(picked), "never returns an unsupported type");
}

// ---------------------------------------------------------------------------
// The allowlist is Gemini's, not ours - lock it so a casual edit is deliberate.
// ---------------------------------------------------------------------------
{
  for (const m of ["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"]) {
    assert.ok(GEMINI_AUDIO_MIME.has(m), `Gemini accepts ${m}`);
  }
  assert.ok(!GEMINI_AUDIO_MIME.has("audio/webm"), "adding webm here would silently restore the bug");
}

// ---------------------------------------------------------------------------
// "IF I TAKE A PHOTO AND PRESS ON TICK, DOES IT REALLY UPLOAD? I DON'T EVEN
// KNOW ABOUT THE UPLOAD THING."
//
// He could not know. Attaching a photo wrote one line into a COLLAPSED
// <details>, and the upload had no on-screen state at all - not attaching, not
// uploading, not uploaded, not failed. Verified against the live project on
// 2026-08-08: the raw-media bucket held 2 objects, both from 2026-06-29, and
// raw_ingestions has never once recorded source_type 'image' or 'audio'.
//
// describeUpload is the copy for the strip that fixes that. Every status has a
// sentence, and a failure always names its reason.
// ---------------------------------------------------------------------------
{
  const photo = { name: "IMG_2043.jpg", size: 2_411_724, type: "image/jpeg" };

  assert.match(describeUpload(photo, { status: "attached" }).text, /Photo attached \(2\.3 MB\)/);
  assert.match(describeUpload(photo, { status: "attached" }).text, /Press Process/);
  assert.equal(describeUpload(photo, { status: "attached" }).tone, "pending");

  assert.match(describeUpload(photo, { status: "uploading" }).text, /Uploading photo/);
  assert.equal(describeUpload(photo, { status: "uploading" }).tone, "busy");

  assert.match(describeUpload(photo, { status: "uploaded" }).text, /Uploaded photo/);
  assert.equal(describeUpload(photo, { status: "uploaded" }).tone, "ok");

  // A FAILURE THAT DOES NOT SAY WHY IS THE SAME SILENCE ONE LEVEL UP.
  const failed = describeUpload(photo, { status: "failed", error: "new row violates row-level security policy" });
  assert.equal(failed.tone, "error");
  assert.match(failed.text, /row-level security/, "the reason survives into the sentence");
  assert.match(failed.text, /retry/i, "and it says what happens next");
  // Even with no reason supplied it must not claim to have one.
  assert.match(describeUpload(photo, { status: "failed" }).text, /no reason given/);

  // A file the uploader skipped is reported, not dropped in silence - that
  // `continue` in agent-runner.js used to remove a file from a capture with
  // nothing said anywhere.
  assert.equal(describeUpload(photo, { status: "skipped", error: "not a readable file" }).tone, "error");

  // Kind is read from the mime, so a voice note does not read as "photo".
  assert.match(describeUpload({ name: "v.wav", size: 90_000, type: "audio/wav" }, { status: "uploaded" }).text, /voice note/);
  assert.match(describeUpload({ name: "hdfc.xls", size: 90_000, type: "application/vnd.ms-excel" }, { status: "uploaded" }).text, /file/);

  // Never empty, never undefined, whatever it is handed.
  for (const status of ["attached", "uploading", "uploaded", "failed", "skipped", "who-knows", undefined]) {
    const d = describeUpload(undefined, { status });
    assert.ok(d.name, `a nameless attachment still gets a label (${status})`);
    assert.ok(d.text && d.text.length > 0, `every status has copy (${status})`);
    assert.ok(["pending", "busy", "ok", "error"].includes(d.tone), `tone is a closed set (${status})`);
    assert.ok(!/[–—]/.test(d.text), `no em or en dashes (${status})`);
  }
}

// ---------------------------------------------------------------------------
// describeRecording - what pressing Stop actually produced.
//
// The empty blob is the failure that used to be invisible: the waveform moved,
// `blob.size > 0` quietly skipped the attach, and the ONLY report went into the
// collapsed parse log. That is "I press stop and nothing happens", exactly.
// ---------------------------------------------------------------------------
{
  const dead = describeRecording({ size: 0, mime: "audio/webm", ms: 4000 });
  assert.equal(dead.ok, false);
  assert.match(dead.message, /Nothing was recorded/);
  assert.match(dead.message, /another app/, "it names the most likely cause, which is actionable");

  const good = describeRecording({ size: 76_515, mime: "audio/webm;codecs=opus", ms: 6200 });
  assert.equal(good.ok, true);
  assert.match(good.message, /6s/);
  assert.match(good.message, /75 KB/);
  assert.match(good.message, /audio\/webm/, "the container is named, because it decides whether a transcode is needed");
  assert.match(good.message, /transcribed/);

  // Defaults must not throw or produce a half-sentence.
  for (const input of [undefined, {}, { size: 10 }, { size: -1 }, { size: 1, ms: 0 }]) {
    const r = describeRecording(input);
    assert.ok(r.message.length > 0, `every recording outcome has copy: ${JSON.stringify(input)}`);
    assert.ok(!/[–—]/.test(r.message));
  }
  assert.match(describeRecording({ size: 1, ms: 0 }).message, /1s/, "a sub-second clip is 1s, never 0s");
}

// ---------------------------------------------------------------------------
// formatBytes: a MEASURED zero is a fact and prints; an unmeasurable one says so.
// ---------------------------------------------------------------------------
{
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(76_515), "75 KB");
  assert.equal(formatBytes(2_411_724), "2.3 MB");
  assert.equal(formatBytes(undefined), "size unknown", "absent is not zero");
  assert.equal(formatBytes(null), "size unknown");
  assert.equal(formatBytes(NaN), "size unknown");
  assert.equal(formatBytes("nonsense"), "size unknown");
}

// ---------------------------------------------------------------------------
// STRUCTURAL: the runner has to REPORT each upload, and the panel has to render
// it. Copy with nothing wired to it is the same invisibility in a nicer font.
// ---------------------------------------------------------------------------
{
  const runner = readFileSync("src/services/agent-runner.js", "utf8");
  assert.match(runner, /onMedia\?\.\(\{[^}]*status: "uploading"/, "runCapture must announce an upload starting");
  assert.match(runner, /onMedia\?\.\(\{[^}]*status: "uploaded"/, "and its success");
  assert.match(runner, /onMedia\?\.\(\{[^}]*status: "failed"[^}]*error:/, "and its failure, WITH a reason");
  assert.match(runner, /onMedia\?\.\(\{[^}]*status: "skipped"/, "a file the loop skips is named, not silently dropped");

  const panel = readFileSync("src/ui/capture-panel.js", "utf8");
  assert.match(panel, /onMedia\(/, "capture-panel must subscribe to per-file upload state");
  assert.match(panel, /describeUpload\(/, "and render it with the tested copy");
  // describeRecording used to be asserted here, when the Home voice button ran a
  // MediaRecorder alongside the speech recogniser. It no longer does: voice is
  // dictation on both pages, and audio arrives as an attached FILE, which the
  // two assertions above already cover. describeRecording stays exported and
  // tested as a pure formatter for any surface that records in future.
}

console.log("audio-convert tests passed");
