// Client-side media preparation for the capture pipeline.
//
// Images: phone cameras produce 5-15 MB photos; the edge function inlines media
// into Gemini as base64 (×1.37) against a ~20 MB request cap and a tight CPU
// budget, so big photos = slow-or-dead captures. Downscale to ≤1600px JPEG
// (~200-500 KB — plenty for OCR/receipts/food photos) BEFORE upload. Re-encoding
// through canvas also converts formats Gemini may reject (HEIC that the browser
// can decode). If decode fails (e.g. HEIC on a non-Apple browser), return the
// original file — the server surfaces extraction errors explicitly now.
//
// Audio: MediaRecorder containers differ per browser (Chrome/Android webm+opus,
// Safari mp4/AAC, Firefox ogg). Pick a supported type explicitly and label the
// blob with the RECORDER's real mimeType, never a hard-coded one.

const MAX_EDGE_PX = 1600;
const SKIP_BELOW_BYTES = 1_000_000; // small images pass through untouched
const JPEG_QUALITY = 0.8;

export async function prepareImage(file) {
  try {
    if (!file?.type?.startsWith("image/")) return file;
    const needsRecode = /heic|heif/i.test(file.type);
    if (file.size < SKIP_BELOW_BYTES && !needsRecode) return file;

    const bitmap = await decodeImage(file);
    if (!bitmap) return file;
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file; // no win — keep original
    const name = (file.name || "photo").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function decodeImage(file) {
  // createImageBitmap applies EXIF orientation by default in modern browsers.
  try {
    return await createImageBitmap(file);
  } catch {
    // Fallback path (older Safari): <img> + object URL.
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      URL.revokeObjectURL(url);
      return img.width ? img : null;
    } catch {
      return null;
    }
  }
}

// Preference order matters: opus-in-webm is Gemini-friendly and Chrome's
// default; mp4/AAC is what Safari can actually produce; ogg covers Firefox.
const AUDIO_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

export function pickAudioMimeType() {
  if (!globalThis.MediaRecorder?.isTypeSupported) return "";
  for (const t of AUDIO_TYPES) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* keep probing */ }
  }
  return "";
}

export function extForAudioMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("mp4")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "webm";
}

// Rough mobile check — only used to decide whether live SpeechRecognition can
// safely share the microphone with MediaRecorder (it can't on Android Chrome /
// iOS standalone PWAs; concurrent use silently breaks both).
export function isMobileLike() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "");
}
