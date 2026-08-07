// WEBM IN, WAV OUT.
//
// The Gemini API accepts audio/wav, audio/mp3, audio/aiff, audio/aac, audio/ogg
// and audio/flac. It does NOT accept audio/webm - which is exactly what
// MediaRecorder produces by default in Chrome, and exactly what this app has
// been uploading.
//
// So the failure looked like this: record a voice note, watch it upload, see
// "Capture saved", and get nothing. Gemini 400s on the inline part, the edge
// function catches it and continues with `geminiEvidence = ""`, and a capture
// with no typed text reasons over an empty string. In the browser this was
// masked because Web Speech supplied a transcript anyway. In the Android app
// there is no Web Speech API at all, so voice was completely, silently dead.
//
// Converting client-side rather than server-side is deliberate: it also shrinks
// the upload (16 kHz mono is roughly a tenth of a 48 kHz stereo capture), which
// matters far more on the phone than the CPU cost of the decode.

// What Gemini will actually take. Anything else has to be converted or refused -
// never forwarded and hoped for.
export const GEMINI_AUDIO_MIME = new Set([
  "audio/wav", "audio/mp3", "audio/mpeg", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac",
]);

// Speech recognisers are trained at 16 kHz. Higher costs bytes and buys nothing.
const TARGET_RATE = 16000;

/** Strip codec parameters: "audio/webm;codecs=opus" -> "audio/webm". */
export function normaliseAudioType(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}

export function isGeminiAudioMime(mime) {
  return GEMINI_AUDIO_MIME.has(normaliseAudioType(mime));
}

/**
 * What should happen to this file before upload?
 * Pure, so the decision is testable without an AudioContext.
 */
export function plannedUpload({ type = "", size = 0 } = {}, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const mime = normaliseAudioType(type);
  if (!mime.startsWith("audio/")) return { action: "upload", reason: "not audio" };
  if (size > maxBytes) {
    return { action: "reject", reason: `audio is ${Math.round(size / 1048576)} MB, limit ${Math.round(maxBytes / 1048576)} MB` };
  }
  if (isGeminiAudioMime(mime)) return { action: "upload", reason: "already supported" };
  return { action: "transcode", reason: `${mime} is not accepted by the transcription API` };
}

/** Pick the best container MediaRecorder can actually give us on this device. */
export function pickRecorderMime(Recorder = globalThis.MediaRecorder) {
  // Ordered by how little work they leave for later. If the device can record
  // straight into something Gemini accepts, skip the transcode entirely.
  const preferred = ["audio/ogg;codecs=opus", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  if (!Recorder?.isTypeSupported) return "";
  for (const m of preferred) if (Recorder.isTypeSupported(m)) return m;
  return "";
}

/** Little-endian WAV (RIFF) header + 16-bit PCM body. */
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

/** Average the channels down to mono - speech does not need stereo. */
function toMono(audioBuffer) {
  const n = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(n);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i] / channels;
  }
  return out;
}

/** Linear-interpolated resample. Good enough for speech, and dependency-free. */
function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    out[i] = input[lo] + (input[hi] - input[lo]) * (pos - lo);
  }
  return out;
}

/**
 * Convert any browser-decodable audio into 16 kHz mono WAV.
 *
 * Returns the ORIGINAL file unchanged if conversion is impossible, rather than
 * throwing: a slightly-wrong upload still reaches the server, where the MIME
 * guard can refuse it loudly. Losing the recording outright would be worse than
 * either.
 */
export async function toWav(file, { targetRate = TARGET_RATE } = {}) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx || typeof file?.arrayBuffer !== "function") return file;
  let ctx;
  try {
    const bytes = await file.arrayBuffer();
    ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(bytes);
    const mono = toMono(decoded);
    const resampled = resample(mono, decoded.sampleRate, targetRate);
    const blob = encodeWav(resampled, targetRate);
    const name = String(file.name || "voice-note").replace(/\.[^.]+$/, "") + ".wav";
    return new File([blob], name, { type: "audio/wav" });
  } catch (err) {
    console.error("[audio] could not convert to wav, uploading as-is:", err);
    return file;
  } finally {
    try { await ctx?.close(); } catch { /* already closed */ }
  }
}

/** Convert every audio file in a capture; leave images and documents alone. */
export async function prepareAudioFiles(files = []) {
  return Promise.all(files.map(async (f) => {
    const plan = plannedUpload({ type: f?.type, size: f?.size });
    return plan.action === "transcode" ? toWav(f) : f;
  }));
}

// ---------------------------------------------------------------------------
// SAYING WHAT HAPPENED TO A FILE.
//
// The owner's question was "if I take a photo and press the tick, does it
// really upload? I don't even know about the upload thing." He could not know:
// attaching a photo wrote one line into a COLLAPSED <details>, and the upload
// itself had no on-screen state at all - not attaching, not uploading, not
// uploaded, not failed. These two pure functions are the copy for that strip,
// here rather than in the DOM module so every branch is unit-testable.
// ---------------------------------------------------------------------------

/**
 * Human file size. A MEASURED zero is a real fact and prints as "0 B"; an
 * absent one says "size unknown" rather than borrowing zero's clothes.
 * `Number(null)` is 0, which is exactly how absent becomes a measurement.
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "size unknown";
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "size unknown";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One attachment, one sentence. Never returns an empty string, and a failure
 * always carries its reason - "upload failed" with no cause is the same silence
 * one level up.
 *
 * @param {{name?:string, size?:number, type?:string}} file
 * @param {{status?:"attached"|"uploading"|"uploaded"|"failed"|"skipped", error?:string}} state
 */
export function describeUpload(file = {}, state = {}) {
  const name = String(file.name || "attachment");
  const size = formatBytes(file.size);
  const kind = String(file.type || "").startsWith("image/") ? "photo"
    : String(file.type || "").startsWith("audio/") ? "voice note"
    : "file";
  switch (state.status) {
    case "uploading":
      return { name, tone: "busy", text: `Uploading ${kind} (${size})...` };
    case "uploaded":
      return { name, tone: "ok", text: `Uploaded ${kind} (${size}). The AI is reading it.` };
    case "failed":
      return { name, tone: "error", text: `Upload failed: ${state.error || "no reason given"}. It is saved on this phone and will retry.` };
    case "skipped":
      return { name, tone: "error", text: `Skipped: ${state.error || "this is not a readable file"}.` };
    case "attached":
    default:
      return { name, tone: "pending", text: `${kind[0].toUpperCase()}${kind.slice(1)} attached (${size}). Press Process to send it.` };
  }
}

/**
 * What a finished MediaRecorder actually produced, in words.
 *
 * An empty blob is the failure that used to be invisible: the recorder ran, the
 * waveform moved, and `blob.size > 0` quietly skipped the attach - so pressing
 * Stop genuinely did nothing and said nothing.
 */
export function describeRecording({ size = 0, mime = "", ms = 0 } = {}) {
  const bytes = Number(size) || 0;
  if (bytes <= 0) {
    return {
      ok: false,
      message: "Nothing was recorded - the microphone produced no audio. Check that another app is not using it, then tap Voice again.",
    };
  }
  const seconds = Math.max(1, Math.round(Number(ms) / 1000));
  const container = normaliseAudioType(mime) || "audio";
  return {
    ok: true,
    message: `Voice note attached: ${seconds}s, ${formatBytes(bytes)} (${container}). Press Process and it gets transcribed.`,
  };
}
