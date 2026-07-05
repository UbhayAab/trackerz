// Gym page: a SEAMLESS, one-tap workout logger that mirrors the diet hub's
// check-off rhythm (which already feels good).
//
//   Each prescribed exercise shows: muscle · name · prescribed sets×reps, the
//   weight PREFILLED from your last session, and big − / + steppers. You don't
//   type — you nudge the weight if needed and tap ✓. That instantly logs the
//   exercise (prescribed sets × reps at the shown weight) as a workout_logs row;
//   un-tapping deletes it. Bodyweight + composition save on blur. No batch
//   "Log session" button, no per-set forms.

import { planForDate, prescribedExercises, weeklyWorkoutCount } from "../domain/diet/plan.js";
import { reconcileExercises } from "../domain/diet/reconcile.js";
import { logWorkoutSession, logBodyMetric, deleteRow } from "../services/supabase-data.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { goalDisplayValue } from "../domain/goals.js";

const WORKOUT_HOST = "#workoutLog";
const BODY_HOST = "#bodyComposition";
const STATE_PREFIX = "trackerz.gym.v1.";
const STEP = 2.5; // kg per tap — the usual plate jump

let _state = { workoutLogs: [], bodyMetrics: [], budgets: [] };

function canSync() { return Boolean(getCurrentSession()?.user?.id) && !isLocalSession(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round(n) { return Math.round(n * 10) / 10; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function isSameDay(iso, d = new Date()) { if (!iso) return false; const x = new Date(iso); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate(); }
function shortDate(iso) { return new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" }); }
function dayKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function loadDay(key) { try { return JSON.parse(globalThis.localStorage?.getItem(STATE_PREFIX + key) || "{}"); } catch { return {}; } }
function saveDay(key, s) { try { globalThis.localStorage?.setItem(STATE_PREFIX + key, JSON.stringify(s)); } catch { /* private mode */ } }

// Resolve an exercise's effective state: a manual check/uncheck (localStorage has
// an explicit `done`) ALWAYS wins; otherwise a captured-workout auto-match ticks it
// (with an "auto"/"suggested" badge). Mirrors the diet hub's resolveItem.
function resolveExState(exKey, day, recon) {
  const manual = day[exKey];
  if (manual && "done" in manual) {
    return { done: manual.done, source: manual.source || "manual", recordId: manual.recordId, weight: manual.weight };
  }
  const r = recon[exKey];
  if (r?.source === "auto") return { done: true, source: "auto", recordId: r.recordId, weight: manual?.weight };
  if (r?.source === "suggested") return { done: false, source: "suggested", recordId: r.recordId, weight: manual?.weight };
  return { done: false, source: null, weight: manual?.weight };
}

export function sessionVolume(sets = []) { return Math.round((sets || []).reduce((a, s) => a + num(s.reps) * num(s.weight_kg), 0)); }

// Heaviest weight you used for an exercise in your most recent session with it.
export function lastSetFor(workoutLogs, name) {
  const n = String(name || "").toLowerCase();
  for (const w of workoutLogs || []) {
    const ms = (w.sets || []).filter((s) => String(s.exercise || "").toLowerCase() === n);
    if (ms.length) return ms.reduce((b, s) => (num(s.weight_kg) > num(b.weight_kg) ? s : b), ms[0]);
  }
  return null;
}

export function weeklyVolumeByMuscle(workoutLogs, now = new Date()) {
  const since = now.getTime() - 7 * 86400000;
  const out = {};
  for (const w of workoutLogs || []) {
    if (new Date(w.occurred_at).getTime() < since) continue;
    for (const s of w.sets || []) { const m = s.muscle || "other"; out[m] = (out[m] || 0) + num(s.reps) * num(s.weight_kg); }
  }
  return out;
}

function latestMetric(b, t) { const r = (b || []).filter((x) => x.metric_type === t); return r.length ? r[0] : null; }
function metricTrend(b, t) { const r = (b || []).filter((x) => x.metric_type === t); return r.length < 2 ? null : round(num(r[0].value) - num(r[1].value)); }

// A badge when an exercise was ticked from a CAPTURED workout (not a manual tap).
function sourceBadge(source) {
  if (source === "auto") return `<span class="wl-auto" title="auto-checked from a captured workout">auto</span>`;
  if (source === "suggested") return `<span class="wl-suggest" title="possible match from a captured workout — tap to confirm">?</span>`;
  return "";
}

// One exercise card: prefilled weight + steppers + a single ✓ to log. `st` is the
// resolved state (manual tap wins; else captured-workout auto/suggested match).
function exerciseCard(ex, st, workoutLogs) {
  const done = Boolean(st.done);
  const last = lastSetFor(workoutLogs, ex.name);
  const isTimed = ex.repsUnit === "sec";
  const weight = st.weight != null ? st.weight : (last ? num(last.weight_kg) : 0);
  const lastLabel = last ? `last ${last.weight_kg ?? "—"}kg×${last.reps ?? "—"}` : "first time";
  const stepper = isTimed ? "" : `
    <div class="wl-weight-ctl">
      <button type="button" class="wl-step" data-step="-1" data-ex="${ex.key}" aria-label="less weight">−</button>
      <span class="wl-wt"><b>${weight}</b> kg</span>
      <button type="button" class="wl-step" data-step="1" data-ex="${ex.key}" aria-label="more weight">+</button>
    </div>`;
  return `<div class="wl-ex${done ? " is-done" : ""}${st.source === "suggested" ? " is-suggested" : ""}" data-ex="${ex.key}" data-name="${esc(ex.name)}" data-muscle="${esc(ex.muscle)}" data-sets="${ex.sets}" data-reps="${ex.reps}" data-unit="${ex.repsUnit}">
    <div class="wl-ex-row">
      <button type="button" class="wl-check" data-ex="${ex.key}" aria-pressed="${done}" aria-label="log ${esc(ex.name)}">${done ? "✓" : ""}</button>
      <div class="wl-ex-main">
        <div class="wl-ex-head"><span class="wl-muscle wl-muscle-${esc(ex.muscle)}">${esc(ex.muscle)}</span><strong>${esc(ex.name)}</strong>${sourceBadge(st.source)}</div>
        <div class="wl-ex-sub"><span class="wl-prescribe">${ex.sets}×${ex.reps}${isTimed ? "s" : ""}</span><span class="wl-last">${esc(lastLabel)}</span></div>
      </div>
      ${stepper}
    </div>
  </div>`;
}

function noteCard(ex, st) {
  const done = Boolean(st.done);
  return `<div class="wl-note${done ? " is-done" : ""}" data-ex="${ex.key}" data-name="${esc(ex.name)}" data-muscle="${esc(ex.muscle)}" data-note="1">
    <button type="button" class="wl-check" data-ex="${ex.key}" aria-pressed="${done}" aria-label="mark done">${done ? "✓" : ""}</button>
    <span class="wl-muscle wl-muscle-${esc(ex.muscle)}">${esc(ex.muscle)}</span>
    <span class="wl-note-txt">${esc(ex.name)}</span>${sourceBadge(st.source)}
  </div>`;
}

function recentSessions(workoutLogs) {
  // Group logged exercises by day -> one line per day.
  const byDay = new Map();
  for (const w of workoutLogs || []) {
    const k = dayKey(new Date(w.occurred_at));
    const g = byDay.get(k) || { date: w.occurred_at, vol: 0, lifts: new Set(), bw: null };
    g.vol += sessionVolume(w.sets);
    (w.sets || []).forEach((s) => g.lifts.add(s.exercise));
    if (w.bodyweight_kg) g.bw = w.bodyweight_kg;
    byDay.set(k, g);
  }
  const rows = [...byDay.values()].slice(0, 7).map((g) =>
    `<li><span>${esc(shortDate(g.date))}</span><strong>${g.lifts.size} lifts</strong><span class="muted small">${g.vol ? `${g.vol.toLocaleString("en-IN")} kg vol` : "—"}${g.bw ? ` · ${g.bw}kg` : ""}</span></li>`).join("");
  return rows ? `<ul class="wl-sessions">${rows}</ul>` : `<p class="muted small">Your sessions show up here once you tap ✓ on a lift.</p>`;
}

function muscleSummary(workoutLogs) {
  const vol = weeklyVolumeByMuscle(workoutLogs);
  const entries = Object.entries(vol).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  const max = entries[0][1];
  const bars = entries.map(([m, v]) => `<div class="wl-vol-row"><span class="wl-muscle wl-muscle-${esc(m)}">${esc(m)}</span><div class="wl-vol-bar"><i style="width:${Math.round((v / max) * 100)}%"></i></div><span class="muted small">${Math.round(v).toLocaleString("en-IN")} kg</span></div>`).join("");
  return `<div class="wl-volume"><p class="diet-head">📊 This week by muscle</p>${bars}</div>`;
}

export function renderWorkoutPanel(appState) {
  if (appState) _state = { workoutLogs: appState.workoutLogs || [], bodyMetrics: appState.bodyMetrics || [], budgets: appState.budgets || [] };
  const host = document.querySelector(WORKOUT_HOST);
  const bodyHost = document.querySelector(BODY_HOST);
  if (!host) return;

  const plan = planForDate(new Date());
  const exercises = prescribedExercises(plan.workout);
  const day = loadDay(dayKey());
  // Auto-check exercises from a captured workout (manual taps still win).
  const recon = reconcileExercises(plan.workout, _state.workoutLogs, new Date());
  const view = {};
  for (const ex of exercises) view[ex.key] = resolveExState(ex.key, day, recon);
  const doneCount = exercises.filter((e) => e.loggable && view[e.key].done).length;
  const total = exercises.filter((e) => e.loggable).length;
  const weeklyTarget = goalDisplayValue(_state.budgets, "weekly_workouts");
  const weeklyDone = weeklyWorkoutCount(_state.workoutLogs);

  host.innerHTML = `
    <div class="panel-title-row">
      <div><p class="eyebrow">Today · ${esc(plan.weekdayName)}</p><h2>${esc(plan.workout.name)}</h2></div>
      <span class="metric-badge">${total ? `${doneCount}/${total} done` : plan.workout.kind}</span>
    </div>
    ${weeklyTarget ? `<p class="muted small wl-weekly-goal">${weeklyDone} / ${weeklyTarget} workouts this week (last 7 days)</p>` : ""}
    <p class="muted small">${esc(plan.workout.rules || "")} · nudge the weight, tap ✓ to log.</p>
    <div class="wl-exercises">
      ${exercises.map((ex) => (ex.loggable ? exerciseCard(ex, view[ex.key], _state.workoutLogs) : noteCard(ex, view[ex.key]))).join("")}
    </div>
    ${muscleSummary(_state.workoutLogs)}
    <div class="wl-recent"><p class="diet-head">🗓️ Recent sessions</p>${recentSessions(_state.workoutLogs)}</div>
  `;

  if (bodyHost) {
    const w = latestMetric(_state.bodyMetrics, "weight");
    const bf = latestMetric(_state.bodyMetrics, "body_fat_pct");
    const waist = latestMetric(_state.bodyMetrics, "waist_cm");
    const tile = (label, m, unit, trend) => {
      const v = m ? `${round(num(m.value))}${unit}` : "—";
      const arrow = trend == null || trend === 0 ? "" : (trend < 0 ? "▼" : "▲");
      const cls = trend == null || trend === 0 ? "" : (trend < 0 ? "good" : "bad");
      return `<div class="body-tile"><span>${label}</span><strong>${v}</strong>${arrow ? `<span class="body-trend ${cls}">${arrow} ${Math.abs(trend)}${unit}</span>` : `<span class="muted small">${m ? shortDate(m.occurred_at) : "tap to add"}</span>`}</div>`;
    };
    bodyHost.innerHTML = `
      <div class="panel-title-row"><div><p class="eyebrow">Body</p><h2>Composition</h2></div></div>
      <div class="body-tiles">
        ${tile("Weight", w, "kg", metricTrend(_state.bodyMetrics, "weight"))}
        ${tile("Body fat", bf, "%", metricTrend(_state.bodyMetrics, "body_fat_pct"))}
        ${tile("Waist", waist, "cm", metricTrend(_state.bodyMetrics, "waist_cm"))}
      </div>
      <div class="body-form">
        <label class="wl-field"><input type="number" step="0.1" inputmode="decimal" placeholder="weight kg" data-metric="weight" data-unit="kg" /></label>
        <label class="wl-field"><input type="number" step="0.1" inputmode="decimal" placeholder="body fat %" data-metric="body_fat_pct" data-unit="%" /></label>
        <label class="wl-field"><input type="number" step="0.1" inputmode="decimal" placeholder="waist cm" data-metric="waist_cm" data-unit="cm" /></label>
      </div>
      <p class="muted small">Saves the moment you leave a field.</p>
    `;
  }
}

// Log one exercise = prescribed sets × reps at the shown weight -> a workout_logs row.
async function logExercise(exKey) {
  const card = document.querySelector(`.wl-ex[data-ex="${exKey}"], .wl-note[data-ex="${exKey}"]`);
  if (!card) return;
  const key = dayKey();
  const day = loadDay(key);
  const name = card.dataset.name;
  const muscle = card.dataset.muscle;
  const sets = Number(card.dataset.sets) || 1;
  const reps = Number(card.dataset.reps) || 0;
  const isNote = card.dataset.note === "1";
  const weight = day[exKey]?.weight != null ? day[exKey].weight : num(card.querySelector(".wl-wt b")?.textContent);

  day[exKey] = { ...day[exKey], done: true, weight };
  saveDay(key, day);
  renderWorkoutPanel(); // instant optimistic flip

  if (!canSync()) return;
  const setRows = isNote ? [] : Array.from({ length: sets }, (_, i) => ({ exercise: name, muscle, set: i + 1, reps, weight_kg: weight, done: true }));
  try {
    const rec = await logWorkoutSession({ description: name, intensity: muscle, sets: setRows });
    day[exKey] = { ...day[exKey], done: true, weight, recordId: rec.id };
    saveDay(key, day);
    await hydrateStateFromSupabase().catch(() => {});
  } catch { /* keep the local check */ }
}

async function unlogExercise(exKey) {
  const key = dayKey();
  const day = loadDay(key);
  const prev = day[exKey];
  // Tombstone (not delete): a manual uncheck must STICK and block a captured-workout
  // auto-match from re-ticking it on the next render.
  day[exKey] = { done: false, source: "manual", weight: prev?.weight };
  saveDay(key, day);
  renderWorkoutPanel();
  // Only remove a row this panel logged manually — never delete the user's captured
  // workout just because they un-ticked an auto-suggestion.
  if (prev?.recordId && canSync()) {
    try { await deleteRow("workout_logs", prev.recordId); await hydrateStateFromSupabase().catch(() => {}); } catch { /* best effort */ }
  }
}

function adjustWeight(exKey, dir) {
  const key = dayKey();
  const day = loadDay(key);
  const card = document.querySelector(`.wl-ex[data-ex="${exKey}"]`);
  const cur = day[exKey]?.weight != null ? day[exKey].weight : num(card?.querySelector(".wl-wt b")?.textContent);
  const next = Math.max(0, round(cur + dir * STEP));
  day[exKey] = { ...day[exKey], weight: next };
  saveDay(key, day);
  const b = card?.querySelector(".wl-wt b");
  if (b) b.textContent = String(next); // update in place (no full re-render while nudging)
}

let bound = false;
export function bindWorkoutPanel() {
  if (bound) return;
  bound = true;
  document.addEventListener("click", (event) => {
    const step = event.target.closest(".wl-step");
    if (step) { adjustWeight(step.dataset.ex, Number(step.dataset.step)); return; }
    const check = event.target.closest(".wl-check");
    if (check) {
      const exKey = check.dataset.ex;
      const pressed = check.getAttribute("aria-pressed") === "true";
      if (pressed) unlogExercise(exKey); else logExercise(exKey);
    }
  });
  // Body composition saves on blur.
  document.addEventListener("change", async (event) => {
    const inp = event.target.closest("#bodyComposition input[data-metric]");
    if (!inp) return;
    const value = num(inp.value);
    if (!value || !canSync()) return;
    try {
      await logBodyMetric({ metric_type: inp.dataset.metric, value, unit: inp.dataset.unit });
      inp.value = "";
      await hydrateStateFromSupabase().catch(() => {});
    } catch { /* best effort */ }
  });
}
