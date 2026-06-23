// Landing-page diet hub: today's plan as a check-off list (meals, workout,
// supplements, water) + tomorrow's prep list. Checking an item persists to
// localStorage immediately and, when signed in, logs a real row to the matching
// table (food_logs / workout_logs / hydration_logs) so it feeds the trackers.
// Unchecking deletes that row. No "approve" — checking IS the commit.

import { planForDate, MACRO_TARGETS } from "../domain/diet/plan.js";
import { nutrientsSoFar } from "../domain/diet/nutrients.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

const CONTAINER = "#dietPlan";
const STATE_PREFIX = "trackerz.diet.v1.";

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

// Resolve a checklist item id -> { table, payload } for Supabase logging.
function logSpecFor(itemId, plan) {
  const userId = getCurrentSession()?.user?.id;
  if (!userId) return null;
  const now = new Date().toISOString();
  if (itemId.startsWith("meal-")) {
    const meal = plan.meals.find((m) => m.id === itemId);
    if (!meal) return null;
    return { table: "food_logs", payload: {
      user_id: userId, meal_slot: meal.slot, meal_name: meal.name, description: meal.detail,
      calories_estimate: meal.macros.calories, protein_g: meal.macros.protein_g,
      carbs_g: meal.macros.carbs_g, fat_g: meal.macros.fat_g, confidence: 1, occurred_at: now,
    } };
  }
  if (itemId.startsWith("workout-") || itemId.startsWith("walk-")) {
    return { table: "workout_logs", payload: {
      user_id: userId, description: `${plan.workout.name} (${plan.weekdayName})`,
      duration_min: plan.workout.duration_min, intensity: plan.workout.kind, occurred_at: now,
    } };
  }
  if (itemId.startsWith("water-")) {
    const w = plan.water.find((x) => x.id === itemId);
    return { table: "hydration_logs", payload: { user_id: userId, ml: w?.ml || 0, occurred_at: now } };
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

function item(plan, state, { id, time, name, detail, table }) {
  const done = Boolean(state[id]?.done);
  return `<label class="diet-item${done ? " is-done" : ""}">
    <input type="checkbox" data-diet-id="${id}"${done ? " checked" : ""} />
    <span class="diet-time">${time || ""}</span>
    <span class="diet-body"><span class="diet-name">${name}</span>${detail ? `<span class="diet-detail">${detail}</span>` : ""}</span>
  </label>`;
}

function macroTally(plan, state) {
  let cal = 0, protein = 0;
  for (const m of plan.meals) if (state[m.id]?.done) { cal += m.macros.calories; protein += m.macros.protein_g; }
  const pPct = Math.min(100, Math.round((protein / MACRO_TARGETS.protein_g) * 100));
  const cPct = Math.min(100, Math.round((cal / MACRO_TARGETS.calories) * 100));
  return `<div class="diet-macros">
    <div class="diet-macro"><span>Protein</span><strong>${protein} / ${MACRO_TARGETS.protein_g} g</strong><div class="diet-bar"><i style="width:${pPct}%"></i></div></div>
    <div class="diet-macro"><span>Calories</span><strong>${cal} / ${MACRO_TARGETS.calories}</strong><div class="diet-bar"><i style="width:${cPct}%"></i></div></div>
  </div>`;
}

// Full macro + micro panel. Each nutrient fills proportionally to the share of
// the day's calories already checked off, hitting the plan value when complete.
function nutrientPanel(plan, state) {
  const totalCal = plan.meals.reduce((a, m) => a + (m.macros.calories || 0), 0) || 1;
  const eatenCal = plan.meals.reduce((a, m) => a + (state[m.id]?.done ? (m.macros.calories || 0) : 0), 0);
  const frac = eatenCal / totalCal;
  const rows = nutrientsSoFar(plan.dietType, frac);
  const labels = { macro: "Macros", mineral: "Minerals", vitamin: "Vitamins" };
  const section = (g) => {
    const items = rows.filter((r) => r.group === g);
    return `<div class="nutgroup"><p class="nutgroup-head">${labels[g]}</p>${items.map((r) => {
      const pct = Math.min(100, Math.round((r.current / (r.target || 1)) * 100));
      const over = r.limit && r.current > r.target;
      return `<div class="nutrow${over ? " nut-over" : ""}"><span class="nutname">${r.label}${r.limit ? " ≤" : ""}</span><span class="nutval">${r.current} / ${r.target} ${r.unit}</span><div class="nutbar"><i style="width:${pct}%"></i></div></div>`;
    }).join("")}</div>`;
  };
  return `<details class="nutrients"><summary>Macros &amp; micros — full panel (${Math.round(frac * 100)}% of today)</summary>${["macro", "mineral", "vitamin"].map(section).join("")}</details>`;
}

function countDone(ids, state) { return ids.filter((id) => state[id]?.done).length; }

export function renderDietPlan() {
  const el = document.querySelector(CONTAINER);
  if (!el) return;
  const today = new Date();
  const plan = planForDate(today);
  const state = loadDayState(dayKey(today));

  const mealIds = plan.meals.map((m) => m.id);
  const waterIds = plan.water.map((w) => w.id);
  const supIds = plan.supplements.map((s) => s.id);

  el.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Today · ${plan.weekdayName}</p>
        <h2>${plan.dietLabel} · ${plan.workout.name}</h2>
      </div>
      <span class="metric-badge">${countDone(mealIds, state)}/4 meals</span>
    </div>
    ${macroTally(plan, state)}
    ${nutrientPanel(plan, state)}

    <div class="diet-section">
      <p class="diet-head">🍽️ Meals</p>
      ${plan.meals.map((m) => item(plan, state, { id: m.id, time: m.time, name: m.name, detail: m.detail })).join("")}
    </div>

    <div class="diet-section">
      <p class="diet-head">🏋️ ${plan.workout.name} <span class="diet-detail">${plan.workout.rules || ""}</span></p>
      ${item(plan, state, { id: plan.workout.id, time: "", name: plan.workout.items.join(" · ") })}
    </div>

    <div class="diet-section">
      <p class="diet-head">💊 Supplements</p>
      ${plan.supplements.map((s) => item(plan, state, { id: s.id, time: s.time, name: s.name, detail: s.note })).join("")}
    </div>

    <div class="diet-section">
      <p class="diet-head">💧 Water <span class="diet-detail">${countDone(waterIds, state) ? `${plan.water.filter((w) => state[w.id]?.done).reduce((a, w) => a + w.ml, 0)} ml` : "target 3.4–3.5 L"}</span></p>
      ${plan.water.map((w) => item(plan, state, { id: w.id, time: w.time, name: w.label, detail: `${w.ml} ml` })).join("")}
    </div>

    <div class="diet-section diet-prep">
      <p class="diet-head">📋 Prep tonight — for tomorrow (${plan.tomorrowName} · ${plan.tomorrowDietLabel})</p>
      ${plan.prepForTomorrow.map((p) => item(plan, state, { id: p.id, time: "", name: p.text })).join("")}
    </div>
    ${supIds.length ? "" : ""}
  `;
}

let bound = false;
export function bindDietPlan() {
  if (bound) return;
  bound = true;
  const el = document.querySelector(CONTAINER);
  if (!el) return;
  el.addEventListener("change", async (event) => {
    const cb = event.target.closest("input[type=checkbox][data-diet-id]");
    if (!cb) return;
    const id = cb.dataset.dietId;
    const key = dayKey();
    const state = loadDayState(key);
    const plan = planForDate(new Date());

    if (cb.checked) {
      state[id] = { done: true };
      saveDayState(key, state);
      const spec = canSync() ? logSpecFor(id, plan) : null;
      if (spec) {
        try {
          const rec = await insertLog(spec);
          state[id] = { done: true, recordId: rec.id, table: spec.table };
          saveDayState(key, state);
        } catch { /* keep the local check even if the sync write fails */ }
      }
    } else {
      const prev = state[id];
      delete state[id];
      saveDayState(key, state);
      if (prev?.recordId && prev?.table && canSync()) {
        try { await deleteLog(prev.table, prev.recordId); } catch { /* best effort */ }
      }
    }
    // Re-hydrate so the additions feed + glance metrics on Home update too.
    if (canSync()) hydrateStateFromSupabase().catch(() => {});
    renderDietPlan();
  });
}
