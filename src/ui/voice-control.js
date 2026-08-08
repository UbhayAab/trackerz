// ONE VOICE CONTROL, USED BY BOTH SURFACES.
//
// Home and Gym have now diverged twice over the same feature, and the owner has
// reported it twice. The first time they were two different implementations
// over the same speech engine. The second time they shared the engine and STILL
// felt different, because Home wrapped it in extra machinery Gym never had: a
// MediaRecorder running alongside the recogniser as "evidence", an automatic
// fallback to recording, and a Process step before anything was transcribed.
// Gym does exactly one thing - tap, words appear, tap again - and that is the
// one the owner likes.
//
// Sharing a *controller* was not enough, because the surfaces still owned their
// own buttons, labels, states and stop semantics. So this module owns all of it:
// the markup, the two labels, the active class, the toggle, and what a stop
// says. A page cannot render a voice button that behaves differently, because a
// page no longer writes one.
//
// Rule for anything added here later: if it does not apply to BOTH surfaces, it
// does not belong in this file, and it does not belong on the voice button.

import { createDictationController, isLiveTranscriptionSupported } from "../services/speech.js";

export const VOICE_IDLE_LABEL = "🎙 Voice";
export const VOICE_ACTIVE_LABEL = "Listening…";
export const VOICE_ACTIVE_CLASS = "is-active";

/** Is voice offered at all on this device? Both surfaces hide the button if not. */
export { isLiveTranscriptionSupported };

/**
 * The button markup, for a surface that renders its panel from a string.
 * Returns "" when live transcription is unavailable - the same decision on both
 * pages, rather than one hiding it and the other showing a button that fails.
 */
export function voiceButtonHtml({ listening = false, action = "voice", extraClass = "" } = {}) {
  if (!isLiveTranscriptionSupported()) return "";
  const cls = ["secondary-button", "voice-button", extraClass, listening ? VOICE_ACTIVE_CLASS : ""]
    .filter(Boolean).join(" ");
  return `<button type="button" class="${cls}" data-gt="${action}" data-voice-toggle`
    + ` aria-pressed="${listening ? "true" : "false"}">`
    + `${listening ? VOICE_ACTIVE_LABEL : VOICE_IDLE_LABEL}</button>`;
}

/**
 * Paint an EXISTING button, for a surface whose button lives in static HTML.
 * Same labels, same class, same aria as voiceButtonHtml - that is the point.
 */
export function paintVoiceButton(btn, listening) {
  if (!btn) return;
  btn.textContent = listening ? VOICE_ACTIVE_LABEL : VOICE_IDLE_LABEL;
  btn.classList.toggle(VOICE_ACTIVE_CLASS, Boolean(listening));
  btn.setAttribute("aria-pressed", listening ? "true" : "false");
}

/**
 * The toggle itself. Tap to start, tap to stop. Live text goes straight into the
 * box; every stop reports a sentence.
 *
 * @param {object} p
 * @param {() => HTMLElement|null} p.getBox    the textarea receiving the words
 * @param {(msg: string) => void} p.setStatus  where a notice is shown
 * @param {(listening: boolean) => void} p.onListeningChange  repaint hook
 */
export function createVoiceToggle({ getBox, setStatus, onListeningChange }) {
  let listening = false;
  let rec = null;

  const paint = () => { if (typeof onListeningChange === "function") onListeningChange(listening); };
  const say = (msg) => { if (typeof setStatus === "function") setStatus(msg); };

  async function stop() {
    if (!listening) return;
    listening = false;
    paint();
    say("Finishing up...");
    await rec?.stop();
    rec = null;
  }

  return {
    isListening: () => listening,
    stop,
    async toggle() {
      if (listening) return void (await stop());

      rec = createDictationController({
        getBaseText: () => getBox()?.value || "",
        // Direct DOM write, deliberately not a state update: that serialises the
        // whole app state and re-renders every panel, and it would run once per
        // spoken word.
        onText: (text) => { const b = getBox(); if (b) b.value = text; },
        onNotice: (message, info) => {
          say(message);
          if (info?.fatal) { listening = false; rec = null; paint(); }
        },
      });
      if (!rec.start()) { rec = null; return; } // the controller already said why
      listening = true;
      paint();
    },
  };
}
