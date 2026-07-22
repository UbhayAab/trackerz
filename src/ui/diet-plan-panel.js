// Landing-page diet hub: a day's plan as a check-off list (meals, workout,
// supplements, water) + tomorrow's prep list. Checking an item persists to
// localStorage immediately and, when signed in, logs a real row to the matching
// table (food_logs / workout_logs / hydration_logs) so it feeds the trackers.
// Unchecking deletes that row. No "approve" - checking IS the commit.
//
// The hub is DATE-AWARE. Three ways to reach a day, all on the same _viewDate:
//   1. the ◀ date ▶ stepper (never steps past today),
//   2. a native <input type="date"> (the "calendar thing" - any day in one tap),
//   3. a swipeable strip of the last 14 days, each with a dot saying whether
//      anything was logged that day.
// So a backdated capture ("on 25th June I had egg curry for dinner") shows up on
// the right day, and yesterday is one tap away. Under the plan we list what was
// ACTUALLY logged on the view date. Three states that must stay distinguishable:
// loaded-with-rows, loaded-and-empty ("nothing logged this day"), and FAILED TO
// LOAD (shows the error + a retry). A failed read must never look like an empty
// day, and an unknown day's dot must never look like an empty one.
//
// On every day we RECONCILE that day's logged rows against the plan -
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
import { showToast } from "./toast.js";
import {
  buildDayStrip, clampToToday, dayDotState, dayKeyOf, dayLabel, loggedDayKeys, parseDayKey,
} from "../../lib/day-strip.mjs";

const CONTAINER = "#dietPlan";
const STATE_PREFIX = "trackerz.diet.v1.";
const STRIP_DAYS = 14;

// The day the hub is currently showing (defaults to today). The stepper moves it.
let _viewDate = startOfDay(new Date());
// Reconciled matches for the view date: { [itemId]: { source, confidence, recordId, table } }.
let _recon = {};
// The view date's rows (drive the macro/micro gauges and the "logged" list).
let _dayFood = [];
let _dayWorkout = [];
let _dayHydration = [];
// How the view date's rows were obtained. "idle"/"loading" = we do NOT yet know
// what happened that day; "error" = the read failed (never render it as empty).
let _dayLoad = { status: "idle", error: null };
// Latest appState snapshot, so async re-renders can reuse budgets/foodLogs.
let _appState = null;
// Guards the async reconcile fetch so the subscribe→render loop can't stack it.
let _reconInFlight = false;
// Which of the last STRIP_DAYS days have any log. `presence: null` means we could
// not find out - the strip renders those dots as "unknown", not as empty days.
let _strip = { anchorKey: null, signedIn: false, presence: null, status: "idle", error: null };
let _stripInFlight = false;

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function dayKey(date = _viewDate) { return dayKeyOf(date); }
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

// Rows that carry no value for `key` at all - summing them as 0 would understate
// the day silently, so the UI says how many are missing instead.
function missingFood(key) {
  return _dayFood.filter((f) => num(f[key]) == null).length;
}

// "ok" = we hold this day's rows; "pending" = the read hasn't resolved, so we do
// NOT know what happened that day; "error" = the read failed. Nothing may be
// rendered as a number unless this is "ok".
function dayDataStatus() {
  if (_dayLoad.status === "error") return "error";
  if (_dayLoad.status === "ok" || _dayLoad.status === "local") return "ok";
  return _dayFood.length ? "ok" : "pending";
}

// null (not 0) for anything absent - a missing calorie count is not zero calories.
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function timeOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
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
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw error; // the caller has to restore the tick, so it must know
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

// A meal auto/suggested-ticked from a real capture is matched by NAME (token
// overlap), not by portion size - "3 eggs and 2 rotis" ticks the same "Egg curry +
// 2 rotis" plan slot as "4 whole eggs" would. Showing the plan's fixed detail text
// next to that tick claims you ate the planned portion regardless of what you
// actually logged. Once a real row backs the tick, show what was ACTUALLY logged.
function foodDescriptionFor(recordId) {
  const row = _dayFood.find((f) => f.id === recordId);
  return row?.description || null;
}

function item(plan, state, { id, time, name, detail }) {
  const r = resolveItem(id, state);
  const cls = [r.done ? "is-done" : "", r.source === "auto" ? "is-auto" : "", r.source === "suggested" ? "is-suggested" : ""].filter(Boolean).join(" ");
  const badge = r.source === "auto" ? '<span class="diet-auto" title="Auto-logged from a capture">auto</span>'
    : r.source === "suggested" ? '<span class="diet-suggest" title="Looks logged - tap to confirm">suggested</span>' : "";
  const actual = r.table === "food_logs" && r.recordId ? foodDescriptionFor(r.recordId) : null;
  const shownDetail = actual || detail;
  // id/time/name all come from a user_plans payload the AI authored, so every one
  // of them is untrusted text - never interpolate them raw.
  return `<label class="diet-item${cls ? " " + cls : ""}">
    <input type="checkbox" data-diet-id="${escapeHtml(id)}"${r.done ? " checked" : ""} />
    <span class="diet-time">${escapeHtml(time || "")}</span>
    <span class="diet-body"><span class="diet-name">${escapeHtml(name)}${badge}</span>${shownDetail ? `<span class="diet-detail">${actual ? "Logged: " : ""}${escapeHtml(shownDetail)}</span>` : ""}</span>
  </label>`;
}

// Quotes are escaped too because this also guards attribute values (data-diet-id).
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
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
  // While the day's rows are unknown (loading) or unreadable (error), "0 / 130 g"
  // would assert the owner ate nothing. Show em-dashes and say why instead.
  const status = dayDataStatus();
  if (status !== "ok") {
    const note = status === "error"
      ? `Couldn't load this day - totals unknown (${_dayLoad.error || "unknown error"})`
      : "Loading this day's logs…";
    return `<div class="diet-macros">
      <div class="diet-macro"><span>Protein</span><strong>- / ${plan.macroTargets.protein_g} g</strong><div class="diet-bar"></div></div>
      <div class="diet-macro"><span>Calories</span><strong>- / ${plan.macroTargets.calories}</strong><div class="diet-bar"></div></div>
      <p class="diet-note${status === "error" ? " is-error" : ""}">${escapeHtml(note)}</p>
    </div>`;
  }
  const missingCal = missingFood("calories_estimate");
  const cal = Math.round(sumFood("calories_estimate"));
  const protein = Math.round(sumFood("protein_g"));
  const pPct = Math.min(100, Math.round((protein / plan.macroTargets.protein_g) * 100));
  const cPct = Math.min(100, Math.round((cal / plan.macroTargets.calories) * 100));
  return `<div class="diet-macros">
    <div class="diet-macro"><span>Protein</span><strong>${protein} / ${plan.macroTargets.protein_g} g</strong><div class="diet-bar"><i style="width:${pPct}%"></i></div></div>
    <div class="diet-macro"><span>Calories</span><strong>${cal} / ${plan.macroTargets.calories}</strong><div class="diet-bar"><i style="width:${cPct}%"></i></div></div>
    ${missingCal ? `<p class="diet-note">${missingCal} logged item${missingCal > 1 ? "s have" : " has"} no calorie estimate - the total is lower than what was actually eaten.</p>` : ""}
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
  return `<details class="nutrients"><summary>Macros &amp; micros - from the day's logs (${Math.round(frac * 100)}% of calorie target · micros estimated · centre = target)</summary>${["macro", "mineral", "vitamin"].map(section).join("")}</details>`;
}

function countDone(ids, state) { return ids.filter((id) => resolveItem(id, state).done).length; }

// Date stepper. ◀ goes back a day, ▶ forward (never past today), "Today" jumps
// back to today when you're in the past. The native date input is the "calendar":
// `max` is today so the picker itself refuses a future day, and the stepper's ▶
// is disabled on today - both guards, because a spoofed input would still be
// clamped in goToDate().
function dateBar() {
  const today = isViewingToday();
  const todayKey = dayKeyOf(new Date());
  return `<div class="diet-datebar">
    <button type="button" class="diet-step" data-diet-step="-1" aria-label="Previous day">◀</button>
    <span class="diet-date">${escapeHtml(dayLabel(_viewDate))}</span>
    <button type="button" class="diet-step" data-diet-step="1" aria-label="Next day"${today ? " disabled" : ""}>▶</button>
    <button type="button" class="diet-today" data-diet-today${today ? " disabled" : ""}>Today</button>
    <label class="diet-cal">
      <span class="sr-only">Pick a date</span>
      <input type="date" data-diet-date value="${dayKey(_viewDate)}" max="${todayKey}" />
    </label>
  </div>`;
}

// The swipeable strip of the last STRIP_DAYS days. The dot is the whole point:
//   ● logged   ○ nothing logged   ? we could not read that day
// "?" and "○" must never collapse into one another - an unread day is not an
// empty day. When the presence lookup failed we say so under the strip.
function daySlider() {
  const days = buildDayStrip(new Date(), STRIP_DAYS);
  const viewKey = dayKey(_viewDate);
  const chips = days.map((d) => {
    const dot = dayDotState(d.key, _strip.presence);
    const selected = d.key === viewKey;
    const dotLabel = dot === "logged" ? "has logs" : dot === "empty" ? "nothing logged" : "log status unknown";
    return `<button type="button" class="diet-chip${selected ? " is-selected" : ""}${d.isToday ? " is-today" : ""}"
      data-diet-day="${d.key}" aria-pressed="${selected}" aria-label="${escapeHtml(`${d.dow} ${d.dom} ${d.month} - ${dotLabel}`)}">
      <span class="chip-dow">${escapeHtml(d.dow)}</span>
      <span class="chip-dom">${d.dom}</span>
      <span class="chip-dot dot-${dot}" aria-hidden="true">${dot === "unknown" ? "?" : ""}</span>
    </button>`;
  }).join("");
  const note = _strip.status === "error"
    ? `<p class="diet-note is-error">Couldn't check which days have logs: ${escapeHtml(_strip.error || "unknown error")} - the ? dots are unknown, not empty.</p>`
    : _strip.status === "local"
      ? '<p class="diet-note">Local session - dots reflect only logs stored on this device.</p>'
      : _strip.presence ? "" : '<p class="diet-note">Checking which days have logs…</p>';
  return `<div class="diet-stripwrap">
    <div class="diet-strip" role="group" aria-label="Last ${STRIP_DAYS} days">${chips}</div>
    ${note}
  </div>`;
}

// One logged food row: the time it happened, what was logged, and the macros that
// were actually recorded. A macro that wasn't recorded prints as "not recorded" -
// never 0, never an estimate invented here.
function foodLogRow(f) {
  const t = timeOf(f.occurred_at);
  const name = f.meal_name || f.description || null;
  const detail = f.meal_name && f.description && f.description !== f.meal_name ? f.description : null;
  const cal = num(f.calories_estimate);
  const protein = num(f.protein_g);
  const macros = [cal != null ? `${Math.round(cal)} kcal` : null, protein != null ? `${Math.round(protein)} g P` : null].filter(Boolean);
  return `<div class="logrow">
    <span class="logtime">${t ? escapeHtml(t) : '<em class="is-missing">no time</em>'}</span>
    <span class="logbody">
      <span class="logname">${name ? escapeHtml(name) : '<em class="is-missing">no description recorded</em>'}${f.meal_slot ? `<span class="logslot">${escapeHtml(f.meal_slot)}</span>` : ""}</span>
      ${detail ? `<span class="logdetail">${escapeHtml(detail)}</span>` : ""}
    </span>
    <span class="logmacros">${macros.length ? escapeHtml(macros.join(" · ")) : '<em class="is-missing">macros not recorded</em>'}</span>
  </div>`;
}

function workoutLogRow(w) {
  const t = timeOf(w.occurred_at);
  const meta = [num(w.duration_min) != null ? `${num(w.duration_min)} min` : null, w.intensity || null].filter(Boolean);
  return `<div class="logrow">
    <span class="logtime">${t ? escapeHtml(t) : '<em class="is-missing">no time</em>'}</span>
    <span class="logbody"><span class="logname">🏋️ ${w.description ? escapeHtml(w.description) : '<em class="is-missing">workout, no description</em>'}</span></span>
    <span class="logmacros">${meta.length ? escapeHtml(meta.join(" · ")) : ""}</span>
  </div>`;
}

function hydrationLogRow(rows) {
  const withMl = rows.filter((r) => num(r.ml) != null);
  const total = withMl.reduce((a, r) => a + num(r.ml), 0);
  const unknown = rows.length - withMl.length;
  return `<div class="logrow">
    <span class="logtime">-</span>
    <span class="logbody"><span class="logname">💧 Water</span>${unknown ? `<span class="logdetail is-missing">${unknown} entr${unknown > 1 ? "ies" : "y"} with no amount recorded</span>` : ""}</span>
    <span class="logmacros">${withMl.length ? `${total} ml` : '<em class="is-missing">amount not recorded</em>'}</span>
  </div>`;
}

// What was ACTUALLY logged on the view date - the answer to "show me yesterday".
// Distinguishes: rows / genuinely empty / still loading / failed to load.
function loggedSection() {
  const today = isViewingToday();
  const status = _dayLoad.status;
  const anyRows = _dayFood.length || _dayWorkout.length || _dayHydration.length;
  let body;

  if (status === "error") {
    body = `<div class="diet-loaderr" role="alert">
      <p class="loaderr-head">Couldn't load this day's logs.</p>
      <p class="loaderr-msg">${escapeHtml(_dayLoad.error || "unknown error")}</p>
      <p class="diet-note">This is not an empty day - we don't know what was logged.</p>
      <button type="button" class="diet-retry" data-diet-retry>Retry</button>
    </div>`;
  } else if (!anyRows && (status === "idle" || status === "loading")) {
    body = '<p class="diet-note">Loading this day\'s logs…</p>';
  } else if (!anyRows) {
    body = `<p class="diet-empty">${today ? "Nothing logged yet today." : "Nothing logged this day."}</p>`;
  } else {
    const rows = [
      ..._dayFood.slice().sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).map(foodLogRow),
      ..._dayWorkout.map(workoutLogRow),
      ...(_dayHydration.length ? [hydrationLogRow(_dayHydration)] : []),
    ];
    body = rows.join("");
  }
  const stillLoading = anyRows && (status === "idle" || status === "loading")
    ? '<p class="diet-note">Still loading - more may follow.</p>' : "";
  const local = status === "local"
    ? '<p class="diet-note">Local session - showing only logs stored on this device.</p>' : "";

  return `<div class="diet-section diet-logged">
    <p class="diet-head">📒 Logged ${today ? "today" : "that day"}${_dayFood.length ? ` <span class="diet-detail">${_dayFood.length} food ${_dayFood.length > 1 ? "entries" : "entry"}</span>` : ""}</p>
    ${body}${stillLoading}${local}
  </div>`;
}

export function renderDietPlan(appState) {
  const el = document.querySelector(CONTAINER);
  if (!el) return;
  if (appState) _appState = appState;

  const plan = planForDate(_viewDate);
  // When not signed in (no fetched rows), fall back to the appState snapshot so
  // the local-only flow still shows what's on this device. This is a KNOWN state
  // ("local"), distinct from a failed remote read - a local day with no rows is a
  // real "nothing logged", not an "unknown".
  if (!canSync() && _dayLoad.status !== "error") {
    _dayFood = logsOnDate(_appState?.foodLogs, _viewDate);
    _dayWorkout = logsOnDate(_appState?.workoutLogs, _viewDate);
    _dayHydration = logsOnDate(_appState?.hydrationLogs, _viewDate);
    _dayLoad = { status: "local", error: null };
  }

  plan.macroTargets = resolveDietTargets(_appState?.budgets, plan.macroTargets);
  const state = loadDayState(dayKey(_viewDate));

  const mealIds = plan.meals.map((m) => m.id);
  const waterIds = plan.water.map((w) => w.id);
  // The denominator is however many meals the plan actually has - an AI-authored
  // override can be 3 or 6, and a hardcoded "/4" would assert a plan that isn't there.
  const mealBadge = mealIds.length
    ? `${countDone(mealIds, state)}/${mealIds.length} meals`
    : "No meals planned";

  el.innerHTML = `
    ${dateBar()}
    ${daySlider()}
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">${isViewingToday() ? "Today" : "Showing"} · ${plan.weekdayName}</p>
        <h2>${escapeHtml(plan.dietLabel)} · ${escapeHtml(plan.workout.name)}</h2>
      </div>
      <span class="metric-badge">${mealBadge}</span>
    </div>
    ${macroTally(plan)}
    ${dayDataStatus() === "ok" ? nutrientPanel(plan) : ""}
    ${loggedSection()}

    <div class="diet-section">
      <p class="diet-head">🍽️ Meals${isViewingToday() ? "" : ' <span class="diet-detail">plan for that weekday - ticks come from real logs</span>'}</p>
      ${plan.meals.map((m) => item(plan, state, { id: m.id, time: m.time, name: m.name, detail: m.detail })).join("")}
    </div>

    <div class="diet-section">
      <p class="diet-head">🏋️ ${escapeHtml(plan.workout.name)} <span class="diet-detail">${escapeHtml(plan.workout.rules || "")}</span></p>
      ${item(plan, state, { id: plan.workout.id, time: "", name: "Log this workout", detail: workoutMeta(plan.workout) })}
      <ul class="workout-list">${plan.workout.items.map(formatExercise).join("")}</ul>
    </div>

    <div class="diet-section">
      <p class="diet-head">💊 Supplements</p>
      ${plan.supplements.map((s) => item(plan, state, { id: s.id, time: s.time, name: s.name, detail: s.note })).join("")}
    </div>

    <div class="diet-section">
      <p class="diet-head">💧 Water <span class="diet-detail">${countDone(waterIds, state) ? `${plan.water.filter((w) => resolveItem(w.id, state).done).reduce((a, w) => a + w.ml, 0)} ml` : "target 3.4-3.5 L"}</span></p>
      ${plan.water.map((w) => item(plan, state, { id: w.id, time: w.time, name: w.label, detail: `${w.ml} ml` })).join("")}
    </div>

    <div class="diet-section diet-prep">
      <p class="diet-head">📋 Prep tonight - for tomorrow (${plan.tomorrowName} · ${plan.tomorrowDietLabel})</p>
      ${plan.prepForTomorrow.map((p) => item(plan, state, { id: p.id, time: "", name: p.text })).join("")}
    </div>
  `;

  // When fresh app state arrives (e.g. a capture just landed) and we're on today,
  // reconcile that day's logs so new captures auto-tick their plan items.
  if (appState && isViewingToday() && canSync() && !_reconInFlight) reconcileViewDate();
  // Refresh the strip's per-day dots on fresh state (a new capture may have lit a
  // day). Guarded so the render→refresh→render cycle can't stack (no appState on
  // the inner render). For local sessions this is synchronous and loop-free.
  if (appState) refreshStrip();
}

// Fetch the view date's logged rows, store them, and reconcile them into _recon,
// then re-render so the "Logged" list + auto/suggested ticks appear. A FAILED read
// is recorded as _dayLoad.status="error" (with the message) so the UI can show the
// error instead of a false "nothing logged" - swallowing it here would erase the
// difference between an empty day and an unreadable one.
async function reconcileViewDate() {
  if (!canSync()) { _recon = {}; return; } // local flow: render() fills from appState
  if (_reconInFlight) return;
  _reconInFlight = true;
  const forDate = _viewDate; // guard against a rapid re-navigation resolving stale
  try {
    const logs = await fetchDayLogs(forDate);
    if (!isSameViewDate(forDate)) return; // user moved on; drop this result
    _dayFood = logs.foodLogs || [];
    _dayWorkout = logs.workoutLogs || [];
    _dayHydration = logs.hydrationLogs || [];
    _dayLoad = { status: "ok", error: null };
    _recon = reconcilePlan(planForDate(forDate), logs);
  } catch (err) {
    if (!isSameViewDate(forDate)) return;
    // Do NOT clear _dayFood to []: that would render as "nothing logged". Mark the
    // read as failed and keep the reconcile map empty (no false ticks).
    _dayLoad = { status: "error", error: err?.message || String(err) };
    _recon = {};
  } finally {
    _reconInFlight = false;
  }
  renderDietPlan();
}

function isSameViewDate(date) { return dayKeyOf(date) === dayKeyOf(_viewDate); }

// Recompute which of the last STRIP_DAYS days have logs, for the slider dots.
// `presence` stays null on any failure so those dots render as "?" (unknown), not
// as empty days. Signed-out users get a local presence set from appState.
async function refreshStrip() {
  const anchorKey = dayKeyOf(new Date());
  if (!canSync()) {
    const presence = loggedDayKeys([_appState?.foodLogs, _appState?.workoutLogs, _appState?.hydrationLogs]);
    _strip = { anchorKey, signedIn: false, presence, status: "local", error: null };
    return;
  }
  if (_stripInFlight) return;
  _stripInFlight = true;
  try {
    const oldest = clampToToday(addStripDays(-(STRIP_DAYS - 1)));
    const presence = await fetchLoggedDayKeys(oldest, new Date());
    _strip = { anchorKey, signedIn: true, presence, status: "ok", error: null };
  } catch (err) {
    // Unknown, not empty - leave presence null so every dot reads "?".
    _strip = { anchorKey, signedIn: true, presence: null, status: "error", error: err?.message || String(err) };
  } finally {
    _stripInFlight = false;
  }
  renderDietPlan();
}

function addStripDays(n) { const d = startOfDay(new Date()); d.setDate(d.getDate() + n); return d; }

// One lightweight query per domain over the strip window -> set of local day keys
// that have at least one row. Timestamps-only (no macros) to keep it cheap.
async function fetchLoggedDayKeys(startDate, endDate) {
  const supabase = await getSupabaseClient();
  const start = startOfDay(startDate).toISOString();
  const end = new Date(startOfDay(endDate).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const q = (t) => supabase.from(t).select("occurred_at").gte("occurred_at", start).lt("occurred_at", end);
  const [food, workout, hydration] = await Promise.all([q("food_logs"), q("workout_logs"), q("hydration_logs")]);
  for (const r of [food, workout, hydration]) if (r.error) throw r.error;
  return loggedDayKeys([food.data, workout.data, hydration.data]);
}

function goToDate(date) {
  const clamped = clampToToday(date); // never land on a future day, whatever the source
  _viewDate = startOfDay(clamped);
  _recon = {};
  _dayFood = [];
  _dayWorkout = [];
  _dayHydration = [];
  _dayLoad = { status: canSync() ? "loading" : "idle", error: null };
  renderDietPlan();
  reconcileViewDate();
}

let bound = false;
export function bindDietPlan() {
  if (bound) return;
  bound = true;
  const el = document.querySelector(CONTAINER);
  if (!el) return;

  // Date navigation: stepper arrows, Today, strip chips, retry.
  el.addEventListener("click", (event) => {
    const step = event.target.closest("[data-diet-step]");
    if (step) {
      const delta = Number(step.dataset.dietStep);
      const next = new Date(_viewDate); next.setDate(_viewDate.getDate() + delta);
      if (delta > 0 && startOfDay(next) > startOfDay(new Date())) return; // no future
      goToDate(next);
      return;
    }
    if (event.target.closest("[data-diet-today]")) { goToDate(new Date()); return; }
    const chip = event.target.closest("[data-diet-day]");
    if (chip) {
      const d = parseDayKey(chip.dataset.dietDay);
      if (d) goToDate(d);
      return;
    }
    if (event.target.closest("[data-diet-retry]")) { reconcileViewDate(); }
  });

  // The "calendar thing": jump to any picked day (clamped to today in goToDate).
  el.addEventListener("change", (event) => {
    const input = event.target.closest("input[type=date][data-diet-date]");
    if (!input) return;
    const d = parseDayKey(input.value);
    if (d) goToDate(d);
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
      // If a real row already backs this item (auto/suggested), accept it - don't
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
          } catch (err) {
            // A tick with no row behind it is a lie: the gauges, the trackers and
            // Jarvis all read the row, not the checkbox. Undo the tick instead.
            delete state[id];
            saveDayState(key, state);
            cb.checked = false;
            showToast(`Couldn't log that: ${err?.message || err}`, { kind: "error", duration: 5000 });
            renderDietPlan();
            return;
          }
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
        try {
          await deleteLog(table, recordId);
          delete _recon[id];
        } catch (err) {
          // The row survived, so the item really is still logged - put the tick back.
          state[id] = { done: true, source: prev?.source || match?.source || "manual", recordId, table };
          saveDayState(key, state);
          cb.checked = true;
          showToast(`Couldn't remove that log: ${err?.message || err}`, { kind: "error", duration: 5000 });
          renderDietPlan();
          return;
        }
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
