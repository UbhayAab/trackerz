// Landing-page diet hub: a day's plan as a check-off list (meals, workout,
// supplements, water) + tomorrow's prep list. Checking an item persists to
// localStorage immediately and, when signed in, logs a real row to the matching
// table (food_logs / workout_logs / hydration_logs) so it feeds the trackers.
// Unchecking deletes that row. No "approve" — checking IS the commit.
//
// The hub is DATE-AWARE: a ◀ date ▶ stepper moves the view back to past days, so
// a backdated capture ("on 25th June I had egg curry for dinner") shows up on the
// right day. On every day we RECONCILE that day's logged rows against the plan —
// a free-form/voice/LLM log that matches a plan item auto-ticks it (strong match)
// or shows a faint "suggested" tick (weak match) you can confirm. A logged item
// with no plan match (e.g. "cake") still feeds the gauges; it just isn't a tick.

import { planForDate } from "../domain/diet/plan.js";
import { reconcilePlan, logsOnDate } from "../domain/diet/reconcile.js";
import { nutrientsSoFar, gauge } from "../domain/diet/nutrients.js";
import { resolveDietTargets } from "../domain/goals.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";
import { fetchDayLogs } from "../services/supabase-data.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

const CONTAINER = "#dietPlan";
const STATE_PREFIX = "trackerz.diet.v1.";

// The day the hub is currently showing (defaults to today). The stepper moves it.
let _viewDate = startOfDay(new Date());
// Reconciled matches for the view date: { [itemId]: { source, confidence, recordId, table } }.
let _recon = {};
// The view date's food rows (drives the macro/micro gauges).
let _dayFood = [];
// Latest appState snapshot, so async re-renders can reuse budgets/foodLogs.
let _appState = null;
// Guards the async reconcile fetch so the subscribe→render loop can't stack it.
let _reconInFlight = false;

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function dayKey(date = _viewDate) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function isViewingToday() { return dayKey(_viewDate) === dayKey(startOfDay(new Date())); }
// Noon of the view date, so a manual check on a past day logs to THAT day.
function occurredAtFor() {
  if (isViewingToday()) return new Date().toISOString();
  return new Date(_viewDate.getFullYear(), _viewDate.getMonth(), _viewDate.getDate(), 12, 0, 0).toISOString();
}

function loadDayState(key) {
  try { return JSON.parse(globalThis.localStorage?.getItem(STATE_PREFIX + key) || "{}"); } catch { return {}; }
}
function saveDayState(key, state) {
  try { globalThis.localStorage?.setItem(STATE_PREFIX + key, JSON.stringify(state)); } catch { /* private mode */ }
}

function canSync() {
  return Boolean(getCurrentSession()?.user?.id) && !isLocalSession();
}

function sumFood(key) {
  return _dayFood.reduce((a, f) => a + Number(f[key] || 0), 0);
}

// Resolve a checklist item id -> { table, payload } for Supabase logging.
function logSpecFor(itemId, plan) {
  const userId = getCurrentSession()?.user?.id;
  if (!userId) return null;
  const at = occurredAtFor();
  if (itemId.startsWith("meal-")) {
    const meal = plan.meals.find((m) => m.id === itemId);
    if (!meal) return null;
    return { table: "food_logs", payload: {
      user_id: userId, meal_slot: meal.slot, meal_name: meal.name, description: meal.detail,
      calories_estimate: meal.macros.calories, protein_g: meal.macros.protein_g,
      carbs_g: meal.macros.carbs_g, fat_g: meal.macros.fat_g, confidence: 1, occurred_at: at,
    } };
  }
  if (itemId.startsWith("workout-") || itemId.startsWith("walk-")) {
    return { table: "workout_logs", payload: {
      user_id: userId, description: `${plan.workout.name} (${plan.weekdayName})`,
      duration_min: plan.workout.duration_min, intensity: plan.workout.kind, occurred_at: at,
    } };
  }
  if (itemId.startsWith("water-")) {
    const w = plan.water.find((x) => x.id === itemId);
    return { table: "hydration_logs", payload: { user_id: userId, ml: w?.ml || 0, occurred_at: at } };
  }
  return null; // supplements + prep: local-only check-offs
}

async function insertLog(spec) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.from(spec.table).insert(spec.payload).select("id").single();
  if (error) throw error;
  return data;
}
async function deleteLog(table, id) {
  const supabase = await getSupabaseClient();
  await supabase.from(table).delete().eq("id", id);
}

// Effective check state for an item, merging manual localStorage state with the
// reconciled match. Manual state wins (an explicit tap/untap is intentional).
function resolveItem(id, state) {
  const manual = state[id];
  if (manual && "done" in manual) {
    return { done: Boolean(manual.done), source: manual.source || "manual", recordId: manual.recordId, table: manual.table };
  }
  const r = _recon[id];
  if (r?.source === "auto") return { done: true, source: "auto", recordId: r.recordId, table: r.table };
  if (r?.source === "suggested") return { done: false, source: "suggested", recordId: r.recordId, table: r.table };
  return { done: false, source: null };
}

function item(plan, state, { id, time, name, detail }) {
  const r = resolveItem(id, state);
  const cls = [r.done ? "is-done" : "", r.source === "auto" ? "is-auto" : "", r.source === "suggested" ? "is-suggested" : ""].filter(Boolean).join(" ");
  const badge = r.source === "auto" ? '<span class="diet-auto" title="Auto-logged from a capture">auto</span>'
    : r.source === "suggested" ? '<span class="diet-suggest" title="Looks logged — tap to confirm">suggested</span>' : "";
  return `<label class="diet-item${cls ? " " + cls : ""}">
    <input type="checkbox" data-diet-id="${id}"${r.done ? " checked" : ""} />
    <span class="diet-time">${time || ""}</span>
    <span class="diet-body"><span class="diet-name">${name}${badge}</span>${detail ? `<span class="diet-detail">${detail}</span>` : ""}</span>
  </label>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// One exercise string -> a readable row: name on the left, the sets×reps or
// duration pulled out as an accent chip on the right.
function formatExercise(raw) {
  const s = String(raw).trim();
  let name = s, meta = "";
  const sr = s.match(/(\d+)\s*[x×]\s*(\d+)\s*$/i);
  const dur = s.match(/(\d+)\s*min\b/i);
  if (sr) { name = s.slice(0, sr.index).trim(); meta = `${sr[1]}×${sr[2]}`; }
  else if (dur) { meta = `${dur[1]} min`; name = s.replace(dur[0], "").replace(/\s{2,}/g, " ").trim(); }
  return `<li class="workout-row"><span class="workout-name">${escapeHtml(name)}</span>${meta ? `<span class="workout-meta">${escapeHtml(meta)}</span>` : ""}</li>`;
}

function workoutMeta(w) {
  return [w.duration_min ? `${w.duration_min} min` : "", w.kind || ""].filter(Boolean).join(" · ");
}

function macroTally(plan) {
  const cal = Math.round(sumFood("calories_estimate"));
  const protein = Math.round(sumFood("protein_g"));
  const pPct = Math.min(100, Math.round((protein / plan.macroTargets.protein_g) * 100));
  const cPct = Math.min(100, Math.round((cal / plan.macroTargets.calories) * 100));
  return `<div class="diet-macros">
    <div class="diet-macro"><span>Protein</span><strong>${protein} / ${plan.macroTargets.protein_g} g</strong><div class="diet-bar"><i style="width:${pPct}%"></i></div></div>
    <div class="diet-macro"><span>Calories</span><strong>${cal} / ${plan.macroTargets.calories}</strong><div class="diet-bar"><i style="width:${cPct}%"></i></div></div>
  </div>`;
}

// Full macro + micro panel driven by the VIEW DATE'S LOGGED FOOD. Calories/protein/
// carbs/fat are summed from the real food_logs; fiber/sat-fat/micros (which logged
// food doesn't carry) stay proportional estimates scaled to calories-vs-target.
function nutrientPanel(plan) {
  const cal = sumFood("calories_estimate");
  const frac = plan.macroTargets.calories ? cal / plan.macroTargets.calories : 0;
  const rows = nutrientsSoFar(plan.dietType, frac);
  const actual = { calories: cal, protein: sumFood("protein_g"), carbs: sumFood("carbs_g"), fat: sumFood("fat_g") };
  const targetFromScaffold = { calories: "calories", protein: "protein_g", carbs: "carbs_g", fat: "fat_g", fiber: "fiber_g" };
  for (const r of rows) {
    if (r.key in actual) r.current = Math.round(actual[r.key] * 100) / 100;
    const tk = targetFromScaffold[r.key];
    if (tk && plan.macroTargets?.[tk] != null) r.target = plan.macroTargets[tk];
  }
  const labels = { macro: "Macros", mineral: "Minerals", vitamin: "Vitamins" };
  const section = (grp) => {
    const items = rows.filter((r) => r.group === grp);
    return `<div class="nutgroup"><p class="nutgroup-head">${labels[grp]}</p>${items.map((r) => {
      const g = gauge({ current: r.current, target: r.target, kind: r.kind, limit: r.limit });
      return `<div class="nutrow nut-${g.status}${g.over ? " nut-pegged" : ""}">
        <span class="nutname">${r.label}${r.limit ? " ≤" : ""}</span>
        <span class="nutval">${r.current} / ${r.target} ${r.unit}</span>
        <div class="nutgauge" role="img" aria-label="${r.label}: ${r.current} of ${r.target} ${r.unit}">
          <span class="nutgauge-center"></span>
          <span class="nutgauge-ptr" style="left:${g.position}%"></span>
          ${g.over ? '<span class="nutgauge-over">▲ over</span>' : ""}
        </div>
      </div>`;
    }).join("")}</div>`;
  };
  return `<details class="nutrients"><summary>Macros &amp; micros — from the day's logs (${Math.round(frac * 100)}% of calorie target · micros estimated · centre = target)</summary>${["macro", "mineral", "vitamin"].map(section).join("")}</details>`;
}

function countDone(ids, state) { return ids.filter((id) => resolveItem(id, state).done).length; }

// Date stepper. ◀ goes back a day, ▶ forward (never past today), "Today" jumps
// back to today when you're in the past.
function dateStepper() {
  const today = isViewingToday();
  const label = today ? "Today" : _viewDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  return `<div class="diet-datebar">
    <button type="button" class="diet-step" data-diet-step="-1" aria-label="Previous day">◀</button>
    <span class="diet-date">${label}</span>
    <button type="button" class="diet-step" data-diet-step="1" aria-label="Next day"${today ? " disabled" : ""}>▶</button>
    ${today ? "" : '<button type="button" class="diet-today" data-diet-today>Today</button>'}
  </div>`;
}

export function renderDietPlan(appState) {
  const el = document.querySelector(CONTAINER);
  if (!el) return;
  if (appState) _appState = appState;

  const plan = planForDate(_viewDate);
  // When viewing today and not signed in (no fetched rows), fall back to the
  // appState food snapshot so the local-only flow still shows gauges.
  if (isViewingToday() && !_dayFood.length && Array.isArray(_appState?.foodLogs)) {
    _dayFood = logsOnDate(_appState.foodLogs, _viewDate);
  }

  plan.macroTargets = resolveDietTargets(_appState?.budgets, plan.macroTargets);
  const state = loadDayState(dayKey(_viewDate));

  const mealIds = plan.meals.map((m) => m.id);
  const waterIds = plan.water.map((w) => w.id);

  el.innerHTML = `
    ${dateStepper()}
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">${isViewingToday() ? "Today" : "Showing"} · ${plan.weekdayName}</p>
        <h2>${plan.dietLabel} · ${plan.workout.name}</h2>
      </div>
      <span class="metric-badge">${countDone(mealIds, state)}/4 meals</span>
    </div>
    ${macroTally(plan)}
    ${nutrientPanel(plan)}

    <div class="diet-section">
      <p class="diet-head">🍽️ Meals</p>
      ${plan.meals.map((m) => item(plan, state, { id: m.id, time: m.time, name: m.name, detail: m.detail })).join("")}
    </div>

    <div class="diet-section">
      <p class="diet-head">🏋️ ${plan.workout.name} <span class="diet-detail">${plan.workout.rules || ""}</span></p>
      ${item(plan, state, { id: plan.workout.id, time: "", name: "Log this workout", detail: workoutMeta(plan.workout) })}
      <ul class="workout-list">${plan.workout.items.map(formatExercise).join("")}</ul>
    </div>

    <div class="diet-section">
      <p class="diet-head">💊 Supplements</p>
      ${plan.supplements.map((s) => item(plan, state, { id: s.id, time: s.time, name: s.name, detail: s.note })).join("")}
    </div>

    <div class="diet-section">
      <p class="diet-head">💧 Water <span class="diet-detail">${countDone(waterIds, state) ? `${plan.water.filter((w) => resolveItem(w.id, state).done).reduce((a, w) => a + w.ml, 0)} ml` : "target 3.4–3.5 L"}</span></p>
      ${plan.water.map((w) => item(plan, state, { id: w.id, time: w.time, name: w.label, detail: `${w.ml} ml` })).join("")}
    </div>

    <div class="diet-section diet-prep">
      <p class="diet-head">📋 Prep tonight — for tomorrow (${plan.tomorrowName} · ${plan.tomorrowDietLabel})</p>
      ${plan.prepForTomorrow.map((p) => item(plan, state, { id: p.id, time: "", name: p.text })).join("")}
    </div>
  `;

  // When fresh app state arrives (e.g. a capture just landed) and we're on today,
  // reconcile that day's logs so new captures auto-tick their plan items.
  if (appState && isViewingToday() && canSync() && !_reconInFlight) reconcileViewDate();
}

// Fetch the view date's logged rows and reconcile them into _recon, then re-render
// so auto/suggested ticks appear. Best-effort: failures leave manual state intact.
async function reconcileViewDate() {
  if (!canSync()) { _recon = {}; return; }
  if (_reconInFlight) return;
  _reconInFlight = true;
  try {
    const logs = await fetchDayLogs(_viewDate);
    _dayFood = logs.foodLogs;
    const plan = planForDate(_viewDate);
    _recon = reconcilePlan(plan, logs);
  } catch {
    _recon = {};
  } finally {
    _reconInFlight = false;
  }
  renderDietPlan();
}

function goToDate(date) {
  _viewDate = startOfDay(date);
  _recon = {};
  _dayFood = [];
  renderDietPlan();
  reconcileViewDate();
}

let bound = false;
export function bindDietPlan() {
  if (bound) return;
  bound = true;
  const el = document.querySelector(CONTAINER);
  if (!el) return;

  // Date stepper.
  el.addEventListener("click", (event) => {
    const step = event.target.closest("[data-diet-step]");
    if (step) {
      const delta = Number(step.dataset.dietStep);
      const next = new Date(_viewDate); next.setDate(_viewDate.getDate() + delta);
      if (delta > 0 && startOfDay(next) > startOfDay(new Date())) return; // no future
      goToDate(next);
      return;
    }
    if (event.target.closest("[data-diet-today]")) goToDate(new Date());
  });

  el.addEventListener("change", async (event) => {
    const cb = event.target.closest("input[type=checkbox][data-diet-id]");
    if (!cb) return;
    const id = cb.dataset.dietId;
    const key = dayKey(_viewDate);
    const state = loadDayState(key);
    const plan = planForDate(_viewDate);
    const match = _recon[id]; // an existing logged row this item matched

    if (cb.checked) {
      // If a real row already backs this item (auto/suggested), accept it — don't
      // insert a duplicate; remember its id so unchecking can delete it.
      if (match?.recordId) {
        state[id] = { done: true, source: match.source, recordId: match.recordId, table: match.table };
        saveDayState(key, state);
      } else {
        state[id] = { done: true, source: "manual" };
        saveDayState(key, state);
        const spec = canSync() ? logSpecFor(id, plan) : null;
        if (spec) {
          try {
            const rec = await insertLog(spec);
            state[id] = { done: true, source: "manual", recordId: rec.id, table: spec.table };
            saveDayState(key, state);
          } catch { /* keep the local check even if the sync write fails */ }
        }
      }
    } else {
      const prev = state[id];
      const recordId = prev?.recordId || match?.recordId;
      const table = prev?.table || match?.table;
      // Persist an explicit "off" so a reconciled auto-match doesn't re-tick it.
      state[id] = { done: false, source: "manual" };
      saveDayState(key, state);
      if (recordId && table && canSync()) {
        try { await deleteLog(table, recordId); } catch { /* best effort */ }
        delete _recon[id];
      }
    }
    if (canSync()) {
      hydrateStateFromSupabase().catch(() => {});
      reconcileViewDate();
    } else {
      renderDietPlan();
    }
  });
}
