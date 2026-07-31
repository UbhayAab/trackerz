// Gym page, top panel: the two things the owner actually does.
//
// The Gym page used to open on a checklist of nine prescribed exercises, each
// asking you to nudge a weight up from 0 kg and tick it. In a month of real use
// that produced zero rows: every session in "Recent sessions" read "0 lifts",
// and the progression engine had nothing to trend because it discards
// weight_kg 0. Meanwhile the workouts that DID get recorded arrived as free
// text - "Gym cardio + triceps and abs", "In gym, doing back, will do lat press
// too" - typed or spoken into the capture box on Home.
//
// So this panel leads with those two moves: one tap for went/skipped, and one
// line of text or voice that the AI turns into a structured workout. The
// nine-exercise checklist still exists, one tap away, for a day you want it.

import { logGymAnswer, fetchTodayGymAnswer } from "../services/supabase-data.js";
import { runCapture } from "../services/agent-runner.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { planForDate } from "../domain/diet/plan.js";
import { weeklyWorkoutCount } from "../domain/diet/plan.js";
import { goalDisplayValue } from "../domain/goals.js";
import { showToast } from "./toast.js";
import { startLiveTranscription, stopLiveTranscription, isLiveTranscriptionSupported } from "../services/speech.js";

const HOST = "#gymToday";

let _state = { workoutLogs: [], budgets: [] };
let _today = null;      // today's gym answer row, or null
let _busy = false;
let _listening = false;
let _rec = null;

function canSync() { return Boolean(getCurrentSession()?.user?.id) && !isLocalSession(); }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

export function renderGymToday(appState) {
  if (appState) _state = { workoutLogs: appState.workoutLogs || [], budgets: appState.budgets || [] };
  const host = document.querySelector(HOST);
  if (!host) return;

  const plan = planForDate(new Date());
  const status = _today?.status || null;
  const target = goalDisplayValue(_state.budgets, "weekly_workouts");
  const done = weeklyWorkoutCount(_state.workoutLogs);

  host.innerHTML = `
    <div class="panel-title-row">
      <div><p class="eyebrow">Today · ${esc(plan.weekdayName)}</p><h2>${esc(plan.workout.name)}</h2></div>
      ${target ? `<span class="metric-badge">${done} / ${target} this week</span>` : ""}
    </div>

    <div class="gt-answer" role="group" aria-label="Did you train today">
      <button type="button" class="gt-btn gt-yes${status === "done" ? " is-active" : ""}" data-gt="done" ${_busy ? "disabled" : ""}>
        <span class="gt-glyph" aria-hidden="true">✓</span><span>Went</span>
      </button>
      <button type="button" class="gt-btn gt-no${status === "skipped" ? " is-active" : ""}" data-gt="skipped" ${_busy ? "disabled" : ""}>
        <span class="gt-glyph" aria-hidden="true">✕</span><span>Skipped</span>
      </button>
    </div>
    <p class="muted small gt-state">${
      status === "done" ? "Logged as trained today."
      : status === "skipped" ? "Marked skipped - answered, and it will not break your logging streak."
      : "Answer either way. A skip is recorded, not ignored."
    }</p>

    <div class="gt-freetext">
      <label class="visually-hidden" for="gymFreeText">What did you train?</label>
      <textarea id="gymFreeText" rows="2" placeholder="cardio + triceps and abs · bench 3x10 60kg · back day, lat pulldown"></textarea>
      <div class="gt-actions">
        ${isLiveTranscriptionSupported() ? `<button type="button" class="secondary-button gt-voice${_listening ? " is-active" : ""}" data-gt="voice">${_listening ? "Listening…" : "🎙 Voice"}</button>` : ""}
        <button type="button" class="primary-button" data-gt="log" ${_busy ? "disabled" : ""}>${_busy ? "Logging…" : "Log it"}</button>
      </div>
      <p class="muted small">Say it however you say it. The AI turns it into exercises and muscles, and it counts as trained.</p>
    </div>
    <p id="gymTodayStatus" class="agent-detail" aria-live="polite"></p>
  `;
}

function setStatus(msg) {
  const el = document.querySelector("#gymTodayStatus");
  if (el) el.textContent = msg || "";
}

async function refresh() {
  if (!canSync()) return;
  try { _today = await fetchTodayGymAnswer(); } catch { _today = null; }
  renderGymToday();
}

async function answer(status) {
  if (!canSync()) { setStatus("Sign in to log a workout."); return; }
  _busy = true; renderGymToday();
  try {
    await logGymAnswer(status);
    showToast(status === "done" ? "Gym logged." : "Marked as no gym today.");
    await hydrateStateFromSupabase().catch(() => {});
    await refresh();
  } catch (err) {
    setStatus(`Could not save: ${err?.message || err}`);
  } finally {
    _busy = false; renderGymToday();
  }
}

// Free text goes through the SAME capture pipeline as the box on Home, so the
// deterministic salvage, the negation guard and the AI all apply. Typing "no gym
// today" here records a skip rather than a phantom session, exactly as it would
// anywhere else in the app.
async function logFreeText() {
  const box = document.querySelector("#gymFreeText");
  const text = (box?.value || "").trim();
  if (!text) { setStatus("Type or say what you trained first."); return; }
  if (!canSync()) { setStatus("Sign in to log a workout."); return; }

  _busy = true; renderGymToday();
  const restore = document.querySelector("#gymFreeText");
  if (restore) restore.value = text;
  setStatus("Reading that…");
  try {
    await runCapture({ text, captureType: "wellness" });
    setStatus("Logged.");
    showToast("Workout logged.");
    const b = document.querySelector("#gymFreeText");
    if (b) b.value = "";
    await hydrateStateFromSupabase().catch(() => {});
    await refresh();
  } catch (err) {
    // Never clear the box on failure - the words are the only copy.
    setStatus(`Could not log that: ${err?.message || err}. Your text is still in the box.`);
  } finally {
    _busy = false; renderGymToday();
    const b = document.querySelector("#gymFreeText");
    if (b && !b.value) b.value = "";
  }
}

// Tap once to listen, tap again to stop. Re-rendering the panel on every
// interim result would blow away the textarea the user is watching, so the live
// transcript is written straight into the box and only the button state
// re-renders when listening starts or stops.
function dictate() {
  if (_listening) {
    stopLiveTranscription(_rec);
    _rec = null; _listening = false; renderGymToday();
    return;
  }
  const before = (document.querySelector("#gymFreeText")?.value || "").trim();
  _rec = startLiveTranscription({
    onPartial: (text) => {
      const b = document.querySelector("#gymFreeText");
      if (b) b.value = [before, text].filter(Boolean).join(" ").trim();
    },
    onError: (err) => {
      _rec = null; _listening = false; renderGymToday();
      setStatus(`Voice failed: ${err || "unknown"}. Type it instead.`);
    },
  });
  if (!_rec) { setStatus("Voice input is not available in this browser. Type it instead."); return; }
  _listening = true; renderGymToday();
}

export function bindGymToday() {
  const host = document.querySelector(HOST);
  if (!host || host.dataset.gtBound) return;
  host.dataset.gtBound = "1";
  host.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-gt]");
    if (!btn) return;
    const act = btn.dataset.gt;
    if (act === "done" || act === "skipped") return void answer(act);
    if (act === "log") return void logFreeText();
    if (act === "voice") return void dictate();
  });
  renderGymToday();
  refresh();
}
