import assert from "node:assert/strict";
import {
  GEMINI_AUDIO_MIME, normaliseAudioType, isGeminiAudioMime, plannedUpload, pickRecorderMime,
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

console.log("audio-convert tests passed");
