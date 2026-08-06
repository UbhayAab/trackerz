// Browser Web Speech API wrapper.
// Free in Chrome/Edge (uses Google's online speech service automatically).
// Falls back gracefully so the agent runner can use Gemini audio instead.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
// `event.results` is a LIVE, CUMULATIVE, MUTABLE list - not a delta stream. The
// spec allows any entry at index >= resultIndex to be "removed and overwritten",
// and Chrome on Android ignores `continuous`, segmenting internally and
// re-delivering a growing prefix of the same utterance after each restart.
//
// The old code kept `let aggregate = ""` outside the handler and did
// `aggregate += finalChunk`. A buffer that outlives the event cannot un-append a
// result that was later revised, so one sentence became, verbatim from the live
// database on 2026-08-06:
//
//   "I I went I went I went to I went to the I went to the gym I went to the
//    gym today I went to the gym today"
//
// which then went to the agent as evidence. Every prefix appears once, which is
// the fingerprint of appending successive cumulative hypotheses.
//
// So: rebuild the whole transcript from index 0 on EVERY result event, keep text
// from previous auto-restarted sessions in a separate `committed` string, and
// join with an overlap check so a re-delivered prefix collapses instead of
// stacking.

const MAX_RESTARTS = 12;
const RESTART_DELAY_MS = 250;
const SHORT_SESSION_MS = 400; // three of these in a row means a restart storm
const WATCHDOG_MS = 15000; // some Android providers never fire `end` at all

// User-facing copy per spec error code. null = expected, say nothing.
export const SPEECH_ERROR_COPY = {
  "no-speech": "Didn't catch that - tap the mic and speak.",
  "audio-capture": "No microphone found. Check your device.",
  "not-allowed": "Microphone is blocked. Enable it in your browser settings.",
  "service-not-allowed": "Speech service is unavailable on this device.",
  "network": "Live text needs internet - still recording, we'll transcribe on send.",
  "language-not-supported": "That language isn't supported here.",
  "bad-grammar": "Speech grammar error.",
  "aborted": null,
};

// Errors that end the session. `no-speech` and `network` are NOT fatal: the
// MediaRecorder is still capturing audio and Gemini transcribes it on submit,
// so killing the whole session would throw away a recording that still works.
const FATAL = new Set(["not-allowed", "audio-capture", "service-not-allowed"]);

function getRecognitionCtor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

// The native Android recogniser, reached through the Capacitor global exactly the
// way HealthConnect is - no npm specifier, so the no-bundler web build is
// untouched and this is simply `undefined` in a browser.
function nativeSpeech() {
  return globalThis.Capacitor?.isNativePlatform?.() ? globalThis.Capacitor?.Plugins?.Speech : null;
}

export function isLiveTranscriptionSupported() {
  return Boolean(getRecognitionCtor() || nativeSpeech());
}

/**
 * Start dictation on the NATIVE recogniser.
 *
 * Same handle shape as startDictation, so the caller cannot tell which engine it
 * got. The plugin emits the whole transcript on every update - a replace, never
 * an append - and joins across the session restarts Android does at every pause.
 */
function startNativeDictation({ onUpdate, onError, onStateChange, lang }) {
  const Speech = nativeSpeech();
  if (!Speech) return null;
  let text = "";
  let active = true;

  const handles = [
    Speech.addListener?.("speechPartial", (e) => { text = e?.text || text; onUpdate?.({ committed: "", final: "", interim: "", text }); }),
    Speech.addListener?.("speechFinal", (e) => { text = e?.text || text; onUpdate?.({ committed: text, final: "", interim: "", text }); }),
    Speech.addListener?.("speechError", (e) => {
      // The plugin's codes deliberately match the Web Speech names, so one set of
      // user-facing copy serves both engines.
      const code = e?.code || "speech_error";
      if (e?.text) text = e.text;
      onError?.(code, { fatal: FATAL.has(code), message: e?.message || SPEECH_ERROR_COPY[code] || code });
    }),
    Speech.addListener?.("speechState", (e) => onStateChange?.(e?.state === "listening" ? "listening" : "stopped")),
  ];

  const cleanup = () => {
    active = false;
    for (const h of handles) { try { h?.remove?.(); } catch { /* listener already gone */ } }
  };

  Speech.start({ lang }).catch((err) => {
    onError?.(err?.code || "start_failed", { fatal: true, message: err?.message || String(err) });
    cleanup();
  });

  return {
    stop() {
      Speech.stop()
        .then((r) => { if (r?.text) text = r.text; })
        // A failed stop is not nothing: the plugin returns the FINAL transcript
        // here, so swallowing it silently keeps whatever partial text we last
        // saw. Say so, and keep the partial rather than losing the lot.
        .catch((err) => {
          console.error("[speech] native stop failed; keeping the last partial transcript:", err);
          onError?.("stop_failed", { fatal: false, message: "Voice stopped, but the last few words may be missing." });
        })
        .finally(cleanup);
    },
    abort() {
      // Cancel discards the transcript by design, so a failure here genuinely
      // costs nothing the user wanted - but it still gets logged rather than
      // vanishing, because a recogniser that will not cancel holds the mic open.
      Speech.cancel()
        .catch((err) => console.error("[speech] native cancel failed; the mic may still be held:", err))
        .finally(cleanup);
    },
    getText: () => text,
    isActive: () => active,
  };
}

/**
 * Join two transcript fragments without duplicating an overlap.
 *
 * This is the guard against growing-prefix re-delivery: "I went" followed by
 * "I went to the gym" must be "I went to the gym", never "I went I went to the
 * gym". Pure and exported so it can be unit-tested against the real 2026-08-06
 * string without a browser.
 */
export function joinTranscript(base, next) {
  const a = String(base || "").trim();
  const b = String(next || "").trim();
  if (!a) return b;
  if (!b) return a;
  const aw = a.split(/\s+/);
  const bw = b.split(/\s+/);
  const low = (arr) => arr.map((w) => w.toLowerCase()).join(" ");
  if (low(bw).startsWith(low(aw))) return b; // b is a longer revision of a
  if (low(aw).endsWith(low(bw))) return a; // b is already the tail of a
  // Longest run of WORDS that ends `a` and begins `b`. Word boundaries rather
  // than characters: a character-level match silently fuses "the" + "the gym"
  // into "thethe gym", and short character overlaps collide by accident.
  const max = Math.min(aw.length, bw.length);
  for (let n = max; n >= 1; n--) {
    if (low(aw.slice(-n)) === low(bw.slice(0, n))) return [...aw, ...bw.slice(n)].join(" ");
  }
  return `${a} ${b}`;
}

/**
 * Collapse a stutter staircase that already happened.
 *
 * Repairs text produced by any transcription source, not just this one - the
 * broken row is already in `raw_ingestions`, and a native Android recognizer or
 * a server transcript can produce the same shape. Idempotent, so it is safe to
 * run on text that is already clean.
 *
 * Method: repeatedly drop one copy of any run of words that is immediately
 * repeated, longest run first. A growing-prefix staircase converges to its
 * longest segment under that rule.
 *
 * KNOWN TRADEOFF: this also normalises a genuinely doubled word, so "very very
 * good" becomes "very good". That is deliberate. A doubled intensifier costs
 * nothing in a food and gym log; a staircase costs a fabricated meal, because
 * the whole string is handed to the agent as evidence. Runs of two or more
 * distinct words are never collapsed unless they truly repeat, so "2 rotis and
 * 2 rotis more" survives intact.
 */
export function collapseStutter(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return String(text || "").trim();
  const eq = (x, y) => x.length === y.length && x.every((w, i) => w.toLowerCase() === y[i].toLowerCase());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < words.length && !changed; i++) {
      for (let len = Math.floor((words.length - i) / 2); len >= 1; len--) {
        if (eq(words.slice(i, i + len), words.slice(i + len, i + len * 2))) {
          words.splice(i, len); // drop one copy of the repeated run
          changed = true;
          break;
        }
      }
    }
  }
  return words.join(" ");
}

/**
 * Start a dictation session.
 *
 * @param {object} opts
 * @param {(u:{committed:string, final:string, interim:string, text:string})=>void} opts.onUpdate
 *   Fires on every result. `text` is the whole transcript and is a REPLACE, never
 *   an append - callers must assign it, not concatenate. `interim` is volatile and
 *   is thrown away wholesale on the next event; render it dimmed.
 * @param {(code:string, info:{fatal:boolean, message:string})=>void} [opts.onError]
 * @param {(state:"listening"|"restarting"|"stopped")=>void} [opts.onStateChange]
 * @param {string} [opts.lang]
 * @returns {{stop:()=>void, abort:()=>void, getText:()=>string, isActive:()=>boolean}|null}
 */
export function startDictation({ onUpdate, onError, onStateChange, lang = "en-IN" } = {}) {
  // In the Android app there IS no Web Speech API - it is a Chrome-the-browser
  // feature, not a WebView one - so the native recogniser is the only live-text
  // path that exists there. Preferred whenever present.
  const native = startNativeDictation({ onUpdate, onError, onStateChange, lang });
  if (native) return native;

  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  let rec = null;
  let committed = ""; // finals from PREVIOUS sessions, survives auto-restart
  let sessionFinal = ""; // finals from the CURRENT session
  let interim = ""; // volatile, replaced wholesale every event
  let userStopped = false;
  let restarts = 0;
  let shortRuns = 0;
  let sessionStart = 0;
  let watchdog = null;
  let active = false;

  const fullText = () => joinTranscript(joinTranscript(committed, sessionFinal), interim);
  const emit = () => onUpdate?.({ committed, final: sessionFinal, interim, text: fullText() });

  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { try { rec?.abort(); } catch { /* already dead */ } }, WATCHDOG_MS);
  };

  function build() {
    const r = new Ctor();
    r.continuous = true; // honoured on desktop, ignored on Android - hence the restart
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.lang = lang;

    r.onstart = () => {
      active = true;
      sessionStart = Date.now();
      onStateChange?.("listening");
      armWatchdog();
    };

    // REBUILD FROM ZERO. Never `+=` into a buffer that outlives this callback.
    r.onresult = (event) => {
      armWatchdog();
      let f = "";
      let i = "";
      for (let k = 0; k < event.results.length; k++) {
        const res = event.results[k];
        const t = res[0]?.transcript || "";
        if (!t) continue;
        if (res.isFinal) f = joinTranscript(f, t);
        else i = joinTranscript(i, t);
      }
      sessionFinal = f;
      interim = i;
      emit();
    };

    r.onerror = (event) => {
      const code = event.error || "speech_error";
      if (code === "aborted") return; // we caused it
      if (code === "no-speech") return; // benign, `end` restarts us
      const fatal = FATAL.has(code);
      if (fatal) userStopped = true; // stop the restart loop
      onError?.(code, { fatal, message: SPEECH_ERROR_COPY[code] || code });
    };

    r.onend = () => {
      clearTimeout(watchdog);
      active = false;
      // Fold this session's finals into the durable buffer BEFORE restarting -
      // event.results starts empty again in the next session.
      committed = joinTranscript(committed, sessionFinal);
      sessionFinal = "";
      interim = "";
      emit();

      if (userStopped) { onStateChange?.("stopped"); return; }

      // Restart-storm guard: three sub-400ms sessions means the provider is
      // refusing, and hammering start() crashes older Chrome builds.
      shortRuns = (Date.now() - sessionStart < SHORT_SESSION_MS) ? shortRuns + 1 : 0;
      restarts += 1;
      if (shortRuns >= 3 || restarts > MAX_RESTARTS) {
        userStopped = true;
        onStateChange?.("stopped");
        onError?.("restart_exhausted", { fatal: false, message: "Voice stopped. Tap the mic to keep going - your text is safe." });
        return;
      }
      onStateChange?.("restarting");
      setTimeout(() => {
        if (userStopped) return;
        rec = build();
        try { rec.start(); } catch { userStopped = true; onStateChange?.("stopped"); }
      }, RESTART_DELAY_MS);
    };

    return r;
  }

  rec = build();
  try {
    rec.start();
  } catch (err) {
    onError?.("start_failed", { fatal: true, message: err?.message || String(err) });
    return null;
  }

  return {
    // Graceful: lets the provider flush its last final result.
    stop() { userStopped = true; clearTimeout(watchdog); try { rec?.stop(); } catch { /* already stopped */ } },
    // Immediate: discards the in-flight hypothesis.
    abort() { userStopped = true; clearTimeout(watchdog); try { rec?.abort(); } catch { /* already stopped */ } },
    getText: fullText,
    isActive: () => active,
  };
}

// Back-compat shim so existing callers (src/ui/gym-today.js) keep working
// unchanged. onPartial always receives the WHOLE transcript - it is a replace.
export function startLiveTranscription({ onPartial, onFinal, onError, lang = "en-IN" } = {}) {
  return startDictation({
    lang,
    onUpdate: ({ text, committed, final }) => {
      onPartial?.(text);
      const settled = joinTranscript(committed, final);
      if (settled) onFinal?.(settled);
    },
    onError: (code, info) => onError?.(info.message || code),
  });
}

export function stopLiveTranscription(rec) {
  try { rec?.stop?.(); } catch { /* already stopped */ }
}
