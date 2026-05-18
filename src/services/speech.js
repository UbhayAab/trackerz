// Browser Web Speech API wrapper.
// Free in Chrome/Edge (uses Google's online speech service automatically).
// Falls back gracefully so the agent runner can use Gemini audio instead.

function getRecognitionCtor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

export function isLiveTranscriptionSupported() {
  return Boolean(getRecognitionCtor());
}

export function startLiveTranscription({ onPartial, onFinal, onError, lang = "en-IN" } = {}) {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang;

  let aggregate = "";
  rec.addEventListener("result", (event) => {
    let interim = "";
    let finalChunk = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || "";
      if (result.isFinal) finalChunk += transcript + " ";
      else interim += transcript;
    }
    if (finalChunk) {
      aggregate += finalChunk;
      onFinal?.(aggregate.trim());
    }
    onPartial?.((aggregate + interim).trim());
  });
  rec.addEventListener("error", (event) => onError?.(event.error || "speech_error"));
  rec.addEventListener("end", () => onPartial?.(aggregate.trim()));

  try {
    rec.start();
  } catch (err) {
    onError?.(err.message || String(err));
    return null;
  }
  return rec;
}

export function stopLiveTranscription(rec) {
  try { rec?.stop?.(); } catch {}
}
