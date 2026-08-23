// Gym page: the Home Protocol session, logged in one tap per exercise.
//
// Each row states the three things that decide how the set is performed - the
// zone (heavy / medium / pump / core), the prescription, and the one cue that
// matters - then takes the load and a ✓. Ticking logs the prescribed sets ×
// reps at the shown weight as a workout_logs row; un-ticking deletes it.
// Bodyweight and composition still save on blur.
//
// Two things here are not decoration:
//
//   THE ZONE CHIP is the program. One heavy exposure per movement pattern per
//   week is what makes training six days a week survivable, so the row says out
//   loud which kind of set this is, and what to rest, rather than leaving it in
//   a document nobody opens mid-session.
//
//   THE CEILING GAUGE. The dumbbells stop at 25 kg (LOAD_CEILING_KG). The old
//   panel offered an endless + stepper, which quietly implies more weight is the
//   answer forever. This one fills a gauge as the load approaches the wall and,
//   at the wall, names the specific next move - slow the eccentric, add a pause,
//   go unilateral - from PROGRESSION_LADDER. The stepper will not go past it,
//   because there is nothing past it in the room.

import { prescribedExercises } from "../domain/diet/plan.js";
import { reconcileExercises } from "../domain/diet/reconcile.js";
import { workoutForToday, setSelectedLetter, scheduledLetter, rotationIsMemoryOnly } from "../state/gym-day.js";
import {
  LOAD_CEILING_KG, REST_BY_ZONE, ZONE_LABEL, CEILING_TACTICS,
  PROGRESSION_LADDER, SYSTEM_NOTES, MOVEMENT_BANK, PROTOCOL_DAYS,
} from "../../lib/home-protocol.mjs";
import { logWorkoutSession, logBodyMetric, deleteRow } from "../services/supabase-data.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";
import { refreshAfterWrite } from "./refresh.js";

const WORKOUT_HOST = "#workoutLog";
const BODY_HOST = "#bodyComposition";
const STATE_PREFIX = "trackerz.gym.v1.";
const STEP = 2.5; // kg per tap - the usual plate jump

let _state = { workoutLogs: [], bodyMetrics: [], budgets: [] };

function canSync() { return Boolean(getCurrentSession()?.user?.id) && !isLocalSession(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round(n) { return Math.round(n * 10) / 10; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
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

// At or past the wall. Reported per exercise, because the answer ("stop adding
// weight, do THIS instead") is per exercise.
export function atCeiling(weightKg) { return num(weightKg) >= LOAD_CEILING_KG; }

// Which ladder rung to suggest for a maxed lift. Indexed off the exercise's
// position so two maxed lifts in one session do not both say "3s eccentric".
export function ceilingTactic(index) { return CEILING_TACTICS[index % CEILING_TACTICS.length]; }

function latestMetric(b, t) { const r = (b || []).filter((x) => x.metric_type === t); return r.length ? r[0] : null; }
function metricTrend(b, t) { const r = (b || []).filter((x) => x.metric_type === t); return r.length < 2 ? null : round(num(r[0].value) - num(r[1].value)); }

// A badge when an exercise was ticked from a CAPTURED workout (not a manual tap).
function sourceBadge(source) {
  if (source === "auto") return `<span class="wl-auto" title="auto-checked from a captured workout">auto</span>`;
  if (source === "suggested") return `<span class="wl-suggest" title="possible match from a captured workout - tap to confirm">?</span>`;
  return "";
}

function prescriptionText(ex) {
  const reps = ex.repsLabel || `${ex.reps}${ex.repsUnit === "sec" ? "s" : ""}`;
  const sets = ex.sets ? `${ex.sets} x ` : "";
  return `${sets}${reps}${ex.perSide ? " / side" : ""}`;
}

function zoneChip(zone) {
  const label = ZONE_LABEL[zone] || zone;
  const rest = REST_BY_ZONE[zone];
  return `<span class="wl-zone wl-zone-${esc(zone)}" title="${esc(label)} - rest ${rest}s">${esc(label)}<i>${rest}s</i></span>`;
}

// The 25 kg wall, drawn. Below it: how much room is left. At it: the ladder rung
// that replaces "add weight".
function loadRow(ex, weight, index) {
  if (!ex.load) return `<div class="wl-bodyweight">bodyweight</div>`;
  const pct = Math.min(100, (num(weight) / LOAD_CEILING_KG) * 100);
  const hot = atCeiling(weight);
  return `
    <div class="wl-loadrow">
      <button type="button" class="wl-step" data-step="-1" data-ex="${ex.key}" aria-label="less weight">−</button>
      <input class="wl-load" type="number" step="0.5" min="0" max="${LOAD_CEILING_KG}" inputmode="decimal"
             value="${weight ? esc(weight) : ""}" placeholder="0" data-load="${ex.key}" aria-label="load for ${esc(ex.name)} in kg" />
      <span class="wl-unit">kg</span>
      <button type="button" class="wl-step" data-step="1" data-ex="${ex.key}" aria-label="more weight">+</button>
      <div class="wl-gauge${hot ? " is-hot" : ""}" role="presentation"><i style="width:${pct}%"></i></div>
    </div>
    ${hot ? `<p class="wl-ceiling"><b>Ceiling reached</b> The dumbbells are maxed on this lift. Stop adding weight; next block, ${esc(ceilingTactic(index))}.</p>` : ""}`;
}

// One exercise card: zone, prescription, cue, load + a single ✓ to log.
function exerciseCard(ex, st, workoutLogs, index) {
  const done = Boolean(st.done);
  const last = lastSetFor(workoutLogs, ex.name);
  const weight = st.weight != null ? st.weight : (last ? num(last.weight_kg) : 0);
  const lastLabel = last ? `last ${last.weight_kg ?? "-"}kg x ${last.reps ?? "-"}` : "first time";
  return `<div class="wl-ex${done ? " is-done" : ""}${st.source === "suggested" ? " is-suggested" : ""} wl-z-${esc(ex.zone)}"
       data-ex="${ex.key}" data-name="${esc(ex.name)}" data-muscle="${esc(ex.muscle)}" data-sets="${ex.sets}" data-reps="${ex.reps}" data-unit="${ex.repsUnit}">
    <div class="wl-ex-row">
      <button type="button" class="wl-check" data-ex="${ex.key}" aria-pressed="${done}" aria-label="log ${esc(ex.name)}">${done ? "✓" : ""}</button>
      <div class="wl-ex-main">
        <div class="wl-ex-head"><strong>${esc(ex.name)}</strong>${sourceBadge(st.source)}</div>
        <div class="wl-ex-sub">
          <span class="wl-prescribe">${esc(prescriptionText(ex))}</span>
          ${zoneChip(ex.zone)}
          <span class="wl-muscle wl-muscle-${esc(ex.muscle)}">${esc(ex.muscle)}</span>
          <span class="wl-last">${esc(lastLabel)}</span>
        </div>
        ${ex.cue ? `<p class="wl-cue">${esc(ex.cue)}</p>` : ""}
        ${loadRow(ex, weight, index)}
      </div>
    </div>
  </div>`;
}

function noteCard(ex, st) {
  const done = Boolean(st.done);
  return `<div class="wl-note${done ? " is-done" : ""}" data-ex="${ex.key}" data-name="${esc(ex.name)}" data-muscle="${esc(ex.muscle)}" data-note="1">
    <button type="button" class="wl-check" data-ex="${ex.key}" aria-pressed="${done}" aria-label="mark done">${done ? "✓" : ""}</button>
    <span class="wl-note-txt">${esc(ex.name)}</span>${ex.cue ? `<span class="muted small">${esc(ex.cue)}</span>` : ""}${sourceBadge(st.source)}
  </div>`;
}

// The rotation dial. Today's letter carries a dot; the one being trained is
// filled. Tapping another letter says "today I am doing that one" for THIS day
// only - see state/gym-day.js for why it is not an advancing counter.
function rotationDial(activeLetter) {
  const today = scheduledLetter();
  return `<div class="wl-dial" role="group" aria-label="Rotation day">
    ${PROTOCOL_DAYS.map((d) => `<button type="button" class="wl-dial-btn${d.letter === activeLetter ? " is-on" : ""}${d.letter === today ? " is-today" : ""}"
        data-letter="${d.letter}" aria-pressed="${d.letter === activeLetter}" title="${esc(d.name)}">${d.letter}</button>`).join("")}
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
    `<li><span>${esc(shortDate(g.date))}</span><strong>${g.lifts.size} lifts</strong><span class="muted small">${g.vol ? `${g.vol.toLocaleString("en-IN")} kg vol` : "-"}${g.bw ? ` · ${g.bw}kg` : ""}</span></li>`).join("");
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

// The program itself, kept one tap away rather than in a document: the week, the
// progression ladder for when 25 kg runs out, the rules that have to survive a
// bad week, and the swap list.
function protocolReference() {
  const week = PROTOCOL_DAYS.map((d) => `<li><b>${d.letter}</b><span><strong>${esc(d.name.replace(/^Day .\s*-\s*/, ""))}</strong><em>${esc(d.focus)}</em></span></li>`).join("");
  const ladder = PROGRESSION_LADDER.map((r) => `<li>${esc(r)}</li>`).join("");
  const notes = SYSTEM_NOTES.map((n) => `<div class="wl-note-block"><h4>${esc(n.title)}</h4>${n.body.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`).join("");
  const bank = MOVEMENT_BANK.map((m) => `<span>${esc(m)}</span>`).join("");
  return `
    <details class="wl-ref">
      <summary>The rotation <span class="muted small">six days, one heavy exposure per pattern</span></summary>
      <ul class="wl-week">${week}</ul>
    </details>
    <details class="wl-ref">
      <summary>When ${LOAD_CEILING_KG} kg runs out <span class="muted small">${PROGRESSION_LADDER.length} rungs, in order</span></summary>
      <ol class="wl-ladder">${ladder}</ol>
    </details>
    <details class="wl-ref">
      <summary>The system <span class="muted small">rest, deficit, deload, order</span></summary>
      ${notes}
    </details>
    <details class="wl-ref">
      <summary>Movement bank <span class="muted small">${MOVEMENT_BANK.length} swaps</span></summary>
      <div class="wl-bank">${bank}</div>
    </details>`;
}

export function renderWorkoutPanel(appState) {
  if (appState) _state = { workoutLogs: appState.workoutLogs || [], bodyMetrics: appState.bodyMetrics || [], budgets: appState.budgets || [] };
  const host = document.querySelector(WORKOUT_HOST);
  const bodyHost = document.querySelector(BODY_HOST);
  if (!host) return;

  const { workout, letter, swapped } = workoutForToday();
  const exercises = prescribedExercises(workout);
  const day = loadDay(dayKey());
  // Auto-check exercises from a captured workout (manual taps still win).
  const recon = reconcileExercises(workout, _state.workoutLogs, new Date());
  const view = {};
  for (const ex of exercises) view[ex.key] = resolveExState(ex.key, day, recon);
  const loggable = exercises.filter((e) => e.loggable);
  const doneCount = loggable.filter((e) => view[e.key].done).length;
  const total = loggable.length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const title = workout.name.replace(/^Day .\s*-\s*/, "");

  host.innerHTML = `
    ${rotationDial(letter)}
    <div class="wl-dayhead">
      <div class="wl-daychar" aria-hidden="true">${esc(letter || "?")}</div>
      <div class="wl-daymeta">
        <h2>${esc(title)}</h2>
        <p class="wl-focus">${esc(workout.focus || "")}</p>
      </div>
      <span class="metric-badge">${total ? `${doneCount}/${total}` : (workout.rest ? "rest" : workout.kind)}</span>
    </div>
    <div class="wl-meter"><i style="width:${pct}%"></i></div>
    <p class="muted small wl-rules">${esc(workout.rules || "")}${swapped ? (rotationIsMemoryOnly() ? " · swapped for this visit (storage is blocked, so it will not survive a reload)" : " · swapped for today only") : ""}</p>
    <div class="wl-exercises">
      ${exercises.map((ex, i) => (ex.loggable ? exerciseCard(ex, view[ex.key], _state.workoutLogs, i) : noteCard(ex, view[ex.key]))).join("")}
    </div>
    ${protocolReference()}
    ${muscleSummary(_state.workoutLogs)}
    <div class="wl-recent"><p class="diet-head">🗓️ Recent sessions</p>${recentSessions(_state.workoutLogs)}</div>
  `;

  if (bodyHost) {
    const w = latestMetric(_state.bodyMetrics, "weight");
    const bf = latestMetric(_state.bodyMetrics, "body_fat_pct");
    const waist = latestMetric(_state.bodyMetrics, "waist_cm");
    const tile = (label, m, unit, trend) => {
      const v = m ? `${round(num(m.value))}${unit}` : "-";
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
  const weight = day[exKey]?.weight != null ? day[exKey].weight : num(card.querySelector(".wl-load")?.value);

  day[exKey] = { ...day[exKey], done: true, weight };
  saveDay(key, day);
  renderWorkoutPanel(); // instant optimistic flip

  if (!canSync()) return;
  const setRows = isNote ? [] : Array.from({ length: sets }, (_, i) => ({ exercise: name, muscle, set: i + 1, reps, weight_kg: weight, done: true }));
  try {
    const rec = await logWorkoutSession({ description: name, intensity: muscle, sets: setRows });
    day[exKey] = { ...day[exKey], done: true, weight, recordId: rec.id };
    saveDay(key, day);
    await refreshAfterWrite("the set");
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
  // Only remove a row this panel logged manually - never delete the user's captured
  // workout just because they un-ticked an auto-suggestion.
  if (prev?.recordId && canSync()) {
    try { await deleteRow("workout_logs", prev.recordId); await refreshAfterWrite("the set"); } catch { /* best effort */ }
  }
}

// Steppers stop at the ceiling. There is no 27.5 kg dumbbell in the room, and a
// control that pretends otherwise is how you end up logging a number you never
// lifted.
function setWeight(exKey, value, { rerender = false } = {}) {
  const key = dayKey();
  const day = loadDay(key);
  const next = Math.min(LOAD_CEILING_KG, Math.max(0, round(num(value))));
  const was = day[exKey]?.weight;
  day[exKey] = { ...day[exKey], weight: next };
  saveDay(key, day);
  const card = document.querySelector(`.wl-ex[data-ex="${exKey}"]`);
  const input = card?.querySelector(".wl-load");
  if (input && String(num(input.value)) !== String(next)) input.value = String(next);
  // Crossing the ceiling changes what the row SAYS (the gauge turns and the
  // tactic appears), so that transition is the one nudge worth re-rendering for.
  if (rerender || atCeiling(next) !== atCeiling(was)) renderWorkoutPanel();
  else {
    const gauge = card?.querySelector(".wl-gauge i");
    if (gauge) gauge.style.width = `${Math.min(100, (next / LOAD_CEILING_KG) * 100)}%`;
  }
}

function adjustWeight(exKey, dir) {
  const day = loadDay(dayKey());
  const card = document.querySelector(`.wl-ex[data-ex="${exKey}"]`);
  const cur = day[exKey]?.weight != null ? day[exKey].weight : num(card?.querySelector(".wl-load")?.value);
  setWeight(exKey, cur + dir * STEP);
}

let bound = false;
export function bindWorkoutPanel() {
  if (bound) return;
  bound = true;
  document.addEventListener("click", (event) => {
    const dial = event.target.closest(".wl-dial-btn");
    if (dial) { setSelectedLetter(dial.dataset.letter); renderWorkoutPanel(); document.dispatchEvent(new CustomEvent("gym:rotation-changed")); return; }
    const step = event.target.closest(".wl-step");
    if (step) { adjustWeight(step.dataset.ex, Number(step.dataset.step)); return; }
    const check = event.target.closest(".wl-check");
    if (check) {
      const exKey = check.dataset.ex;
      const pressed = check.getAttribute("aria-pressed") === "true";
      if (pressed) unlogExercise(exKey); else logExercise(exKey);
    }
  });
  document.addEventListener("change", async (event) => {
    const load = event.target.closest("input[data-load]");
    if (load) { setWeight(load.dataset.load, load.value); return; }
    // Body composition saves on blur.
    const inp = event.target.closest("#bodyComposition input[data-metric]");
    if (!inp) return;
    const value = num(inp.value);
    if (!value || !canSync()) return;
    try {
      await logBodyMetric({ metric_type: inp.dataset.metric, value, unit: inp.dataset.unit });
      inp.value = "";
      await refreshAfterWrite("the set");
    } catch { /* best effort */ }
  });
}
