// Gym page: a detailed, day-over-day workout + body tracker.
//
//   #workoutLog      today's prescribed workout, expanded per-exercise into set
//                    rows (reps + weight, prefilled from your LAST session for
//                    progressive overload), a one-tap "Log session", recent
//                    sessions, and weekly volume per muscle.
//   #bodyComposition weight / body-fat% / waist, latest value + trend, reusing
//                    the existing body_metrics table (no new measurements table).
//
// One logged session = one workout_logs row, with the per-exercise sets stored as
// JSONB on that row. No extra tables.

import { planForDate, prescribedExercises } from "../domain/diet/plan.js";
import { logWorkoutSession, logBodyMetric } from "../services/supabase-data.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

const WORKOUT_HOST = "#workoutLog";
const BODY_HOST = "#bodyComposition";

let _state = { workoutLogs: [], bodyMetrics: [] };

function canSync() {
  return Boolean(getCurrentSession()?.user?.id) && !isLocalSession();
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round(n) { return Math.round(n * 10) / 10; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function isSameDay(iso, d = new Date()) {
  if (!iso) return false;
  const x = new Date(iso);
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
}
function shortDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

// Total tonnage of a session's set list = Σ reps × weight.
export function sessionVolume(sets = []) {
  return Math.round((sets || []).reduce((a, s) => a + num(s.reps) * num(s.weight_kg), 0));
}

// The heaviest set you logged for an exercise in your most recent session that
// had it — used to prefill the inputs (so each week you start from last week).
export function lastSetFor(workoutLogs, exerciseName) {
  const name = String(exerciseName || "").toLowerCase();
  for (const w of workoutLogs || []) {
    const matches = (w.sets || []).filter((s) => String(s.exercise || "").toLowerCase() === name);
    if (matches.length) {
      return matches.reduce((best, s) => (num(s.weight_kg) > num(best.weight_kg) ? s : best), matches[0]);
    }
  }
  return null;
}

// Weekly volume per muscle group over the last 7 days.
export function weeklyVolumeByMuscle(workoutLogs, now = new Date()) {
  const since = now.getTime() - 7 * 86400000;
  const out = {};
  for (const w of workoutLogs || []) {
    if (new Date(w.occurred_at).getTime() < since) continue;
    for (const s of w.sets || []) {
      const m = s.muscle || "other";
      out[m] = (out[m] || 0) + num(s.reps) * num(s.weight_kg);
    }
  }
  return out;
}

function latestMetric(bodyMetrics, type) {
  const rows = (bodyMetrics || []).filter((r) => r.metric_type === type);
  return rows.length ? rows[0] : null; // already sorted desc by occurred_at
}
function metricTrend(bodyMetrics, type) {
  const rows = (bodyMetrics || []).filter((r) => r.metric_type === type);
  if (rows.length < 2) return null;
  return round(num(rows[0].value) - num(rows[1].value)); // newest minus previous
}

function setRow(ex, idx, last) {
  const reps = last?.reps ?? ex.reps;
  const wt = last?.weight_kg ?? "";
  return `<div class="wl-set" data-ex="${esc(ex.name)}" data-muscle="${esc(ex.muscle)}" data-set="${idx + 1}">
    <span class="wl-set-n">Set ${idx + 1}</span>
    <label class="wl-field"><input type="number" class="wl-reps" min="0" inputmode="numeric" value="${reps}" /> <span>${ex.repsUnit === "sec" ? "sec" : "reps"}</span></label>
    <label class="wl-field"><input type="number" class="wl-weight" min="0" step="0.5" inputmode="decimal" value="${wt}" placeholder="${last ? "" : "kg"}" /> <span>kg</span></label>
    <input type="checkbox" class="wl-done" aria-label="set done" ${last ? "" : ""} />
  </div>`;
}

function exerciseBlock(ex, workoutLogs) {
  if (!ex.loggable) {
    return `<div class="wl-note"><span class="wl-muscle wl-muscle-cardio">${esc(ex.muscle)}</span> ${esc(ex.name)}</div>`;
  }
  const last = lastSetFor(workoutLogs, ex.name);
  const lastLabel = last ? `last: ${last.weight_kg ?? "—"}kg × ${last.reps ?? "—"}` : "first time";
  const rows = Array.from({ length: ex.sets }, (_, i) => setRow(ex, i, last)).join("");
  return `<div class="wl-ex">
    <div class="wl-ex-head">
      <span class="wl-muscle wl-muscle-${esc(ex.muscle)}">${esc(ex.muscle)}</span>
      <strong>${esc(ex.name)}</strong>
      <span class="wl-prescribe">${ex.sets}×${ex.reps}${ex.repsUnit === "sec" ? "s" : ""}</span>
      <span class="wl-last">${esc(lastLabel)}</span>
    </div>
    ${rows}
  </div>`;
}

function recentSessions(workoutLogs) {
  const rows = (workoutLogs || []).slice(0, 6).map((w) => {
    const vol = sessionVolume(w.sets);
    const exCount = new Set((w.sets || []).map((s) => s.exercise)).size;
    return `<li><span>${esc(shortDate(w.occurred_at))}</span><strong>${esc(w.description || "Workout")}</strong><span class="muted small">${exCount} lifts · ${vol ? `${vol.toLocaleString("en-IN")} kg vol` : "—"}${w.bodyweight_kg ? ` · ${w.bodyweight_kg}kg BW` : ""}</span></li>`;
  }).join("");
  return rows ? `<ul class="wl-sessions">${rows}</ul>` : `<p class="muted small">No sessions logged yet — log today's above.</p>`;
}

function muscleSummary(workoutLogs) {
  const vol = weeklyVolumeByMuscle(workoutLogs);
  const entries = Object.entries(vol).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  const max = entries[0][1];
  const bars = entries.map(([m, v]) => `<div class="wl-vol-row"><span class="wl-muscle wl-muscle-${esc(m)}">${esc(m)}</span><div class="wl-vol-bar"><i style="width:${Math.round((v / max) * 100)}%"></i></div><span class="muted small">${Math.round(v).toLocaleString("en-IN")} kg</span></div>`).join("");
  return `<div class="wl-volume"><p class="diet-head">📊 This week's volume by muscle</p>${bars}</div>`;
}

export function renderWorkoutPanel(appState) {
  if (appState) _state = { workoutLogs: appState.workoutLogs || [], bodyMetrics: appState.bodyMetrics || [] };
  const host = document.querySelector(WORKOUT_HOST);
  const bodyHost = document.querySelector(BODY_HOST);
  if (!host) return;

  const plan = planForDate(new Date());
  const exercises = prescribedExercises(plan.workout);
  const loggedToday = (_state.workoutLogs || []).find((w) => isSameDay(w.occurred_at) && (w.sets || []).length);
  const muscles = [...new Set(exercises.filter((e) => e.loggable).map((e) => e.muscle))];

  host.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Today · ${esc(plan.weekdayName)}</p>
        <h2>${esc(plan.workout.name)}</h2>
      </div>
      <span class="metric-badge">${loggedToday ? "✓ logged today" : muscles.join(" · ") || plan.workout.kind}</span>
    </div>
    <p class="muted small">${esc(plan.workout.rules || "")}</p>
    <div class="wl-exercises">
      ${exercises.map((ex) => exerciseBlock(ex, _state.workoutLogs)).join("")}
    </div>
    <div class="wl-actions">
      <label class="wl-field wl-bw"><span>Bodyweight</span><input type="number" id="wlBodyweight" step="0.1" inputmode="decimal" placeholder="kg" /></label>
      <button type="button" id="wlLog" class="primary-button">Log session</button>
    </div>
    <p id="wlStatus" class="muted small" aria-live="polite"></p>
    ${muscleSummary(_state.workoutLogs)}
    <div class="wl-recent"><p class="diet-head">🗓️ Recent sessions</p>${recentSessions(_state.workoutLogs)}</div>
  `;

  if (bodyHost) {
    const w = latestMetric(_state.bodyMetrics, "weight");
    const bf = latestMetric(_state.bodyMetrics, "body_fat_pct");
    const waist = latestMetric(_state.bodyMetrics, "waist_cm");
    const tw = metricTrend(_state.bodyMetrics, "weight");
    const tile = (label, m, unit, trend, goodDown = true) => {
      const v = m ? `${round(num(m.value))}${unit}` : "—";
      const arrow = trend == null || trend === 0 ? "" : (trend < 0 ? "▼" : "▲");
      const cls = trend == null || trend === 0 ? "" : ((trend < 0) === goodDown ? "good" : "bad");
      return `<div class="body-tile"><span>${label}</span><strong>${v}</strong>${arrow ? `<span class="body-trend ${cls}">${arrow} ${Math.abs(trend)}${unit}</span>` : `<span class="muted small">${m ? shortDate(m.occurred_at) : "no data"}</span>`}</div>`;
    };
    bodyHost.innerHTML = `
      <div class="panel-title-row"><div><p class="eyebrow">Body</p><h2>Composition</h2></div></div>
      <div class="body-tiles">
        ${tile("Weight", w, "kg", tw, true)}
        ${tile("Body fat", bf, "%", metricTrend(_state.bodyMetrics, "body_fat_pct"), true)}
        ${tile("Waist", waist, "cm", metricTrend(_state.bodyMetrics, "waist_cm"), true)}
      </div>
      <div class="body-form">
        <label class="wl-field"><input type="number" id="bcWeight" step="0.1" inputmode="decimal" placeholder="weight kg" /></label>
        <label class="wl-field"><input type="number" id="bcFat" step="0.1" inputmode="decimal" placeholder="body fat %" /></label>
        <label class="wl-field"><input type="number" id="bcWaist" step="0.1" inputmode="decimal" placeholder="waist cm" /></label>
        <button type="button" id="bcSave" class="secondary-button">Save</button>
      </div>
      <p id="bcStatus" class="muted small" aria-live="polite"></p>
    `;
  }
}

async function onLogSession() {
  const host = document.querySelector(WORKOUT_HOST);
  const status = host?.querySelector("#wlStatus");
  const plan = planForDate(new Date());
  const sets = [];
  host?.querySelectorAll(".wl-set").forEach((row) => {
    const reps = num(row.querySelector(".wl-reps")?.value);
    const weight = num(row.querySelector(".wl-weight")?.value);
    const done = row.querySelector(".wl-done")?.checked;
    if (!reps && !weight && !done) return; // skip untouched sets
    sets.push({
      exercise: row.dataset.ex, muscle: row.dataset.muscle,
      set: Number(row.dataset.set), reps, weight_kg: weight, done: Boolean(done),
    });
  });
  if (!sets.length) { if (status) status.textContent = "Enter at least one set (reps or weight) first."; return; }
  const bodyweight = num(document.querySelector("#wlBodyweight")?.value) || null;
  if (status) status.textContent = "Saving…";
  if (!canSync()) { if (status) status.textContent = "Sign in to save workouts to the cloud."; return; }
  try {
    await logWorkoutSession({
      description: plan.workout.name, intensity: plan.workout.kind,
      duration_min: plan.workout.duration_min, sets, bodyweight_kg: bodyweight,
    });
    if (bodyweight) await logBodyMetric({ metric_type: "weight", value: bodyweight, unit: "kg" }).catch(() => {});
    if (status) status.textContent = `Logged ${sets.length} sets · ${sessionVolume(sets).toLocaleString("en-IN")} kg volume.`;
    await hydrateStateFromSupabase().catch(() => {});
  } catch (e) {
    if (status) status.textContent = `Save failed: ${e?.message || e}`;
  }
}

async function onSaveBody() {
  const status = document.querySelector("#bcStatus");
  const w = num(document.querySelector("#bcWeight")?.value);
  const bf = num(document.querySelector("#bcFat")?.value);
  const waist = num(document.querySelector("#bcWaist")?.value);
  if (!w && !bf && !waist) { if (status) status.textContent = "Enter at least one value."; return; }
  if (!canSync()) { if (status) status.textContent = "Sign in to save."; return; }
  if (status) status.textContent = "Saving…";
  try {
    if (w) await logBodyMetric({ metric_type: "weight", value: w, unit: "kg" });
    if (bf) await logBodyMetric({ metric_type: "body_fat_pct", value: bf, unit: "%" });
    if (waist) await logBodyMetric({ metric_type: "waist_cm", value: waist, unit: "cm" });
    if (status) status.textContent = "Saved.";
    await hydrateStateFromSupabase().catch(() => {});
  } catch (e) {
    if (status) status.textContent = `Save failed: ${e?.message || e}`;
  }
}

let bound = false;
export function bindWorkoutPanel() {
  if (bound) return;
  bound = true;
  document.addEventListener("click", (event) => {
    if (event.target.closest("#wlLog")) onLogSession();
    else if (event.target.closest("#bcSave")) onSaveBody();
  });
}
