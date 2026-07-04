// Day resolver for Ubhay's diet/workout scaffold. The fixed scaffold DATA lives
// in lib/diet-scaffold.mjs (shared, pure); this module resolves a given date by
// folding any user_plans overrides (permanent + date-scoped, full replaces AND
// one-shot deltas) onto that scaffold. No DOM, no Supabase.

import {
  MACRO_TARGETS, sumMealMacros, WEEKDAY_NAMES, isoWeekday, dietTypeForWeekday,
  WORKOUTS, WORKOUT_BY_WEEKDAY, mealsFor, WATER, supplementsFor, prepForTomorrow,
  scaffoldDietPayload, scaffoldGymPayload,
} from "../../../lib/diet-scaffold.mjs";
import { foldPlanPayloads } from "../../../lib/plan-merge.mjs";

// Re-export the scaffold primitives other modules/tests import from here, so the
// extraction to lib/diet-scaffold.mjs keeps this module's public API stable.
export { MACRO_TARGETS, sumMealMacros, isoWeekday };

// Resolve targets: scaffold sum drives calories/protein/carbs/fat (when > 0);
// fiber_g/water_ml fall back to the constant; an explicit override wins outright.
function resolveTargets(meals, overridePayload) {
  const out = { ...MACRO_TARGETS };
  const scaffold = sumMealMacros(meals);
  for (const k of ["calories", "protein_g", "carbs_g", "fat_g"]) if (scaffold[k] > 0) out[k] = scaffold[k];
  Object.assign(out, overridePayload?.targets || {});
  return out;
}

// A permanent diet override from user_plans (payload). When the user pastes/asks
// the AI to update their diet, sync.js calls setDietPlanOverride(payload) and the
// hub shows the new meals/targets instead of the fixed defaults. Deleting that
// row (undo) clears it back to the default plan.
let _dietOverride = null;
export function setDietPlanOverride(payload) {
  _dietOverride = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : null;
}

// Date-scoped overrides: "for the next 4 Mondays I'll have paneer salad" rewrites
// exactly those dates' plan (NOT a log/tick). Keyed by local "YYYY-MM-DD". Each
// value is a single payload OR an array of payloads (a full replace and/or one or
// more deltas) folded in order by planForDate. sync.js builds these from
// user_plans rows whose scope is a comma-separated date list.
let _dietDated = new Map();
let _gymDated = new Map();
export function setDatedPlanOverrides({ diet, gym } = {}) {
  _dietDated = toDateMap(diet);
  _gymDated = toDateMap(gym);
}
function toDateMap(src) {
  if (src instanceof Map) return src;
  const m = new Map();
  if (src && typeof src === "object") for (const [k, v] of Object.entries(src)) m.set(k, v);
  return m;
}

// Normalize a dated-map value to an array of payloads (single payload -> [payload]).
function normRows(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return v ? [v] : [];
}

// Local "YYYY-MM-DD" (matches the diet hub + reconcile day keys — NOT UTC).
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// A user_plans.scope is "permanent" (standing plan), a comma-separated date list
// (recurring/temporary override), or empty (treated permanent). Returns the kind +
// the validated, de-duped dates. Pure.
export function parsePlanScope(scope) {
  const s = String(scope || "").trim();
  if (!s || s === "permanent") return { kind: "permanent", dates: [] };
  const dates = [...new Set(s.split(",").map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))];
  return dates.length ? { kind: "dates", dates } : { kind: "none", dates: [] };
}

// Build a workout object from a date-scoped gym override payload (items list, or a
// per-weekday {days:{Mon:{...}}} map). Returns null when the payload has no usable
// workout so planForDate falls back to the standing cycle.
function gymWorkoutFromPayload(payload, wd) {
  if (!payload || typeof payload !== "object") return null;
  let spec = payload;
  if (payload.days && typeof payload.days === "object") {
    const short = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd];
    spec = payload.days[short] || payload.days[WEEKDAY_NAMES[wd]] || null;
  }
  const items = Array.isArray(spec?.items) ? spec.items : null;
  if (!items || !items.length) return null;
  return {
    id: "workout-custom", name: spec.name || "Custom workout", kind: spec.kind || "gym",
    duration_min: Number(spec.duration_min) || 50, items, rules: spec.rules || "",
  };
}

function overrideMeals(payload) {
  if (!Array.isArray(payload?.meals) || !payload.meals.length) return null;
  return payload.meals.map((m, i) => ({
    id: `meal-ov-${i}`,
    time: m.time || "",
    slot: ["breakfast", "lunch", "snack", "dinner", "other"].includes(m.slot) ? m.slot : "other",
    name: m.name || m.meal_name || `Meal ${i + 1}`,
    detail: m.detail || m.description || "",
    macros: {
      calories: Number(m.calories ?? m.calories_estimate ?? 0),
      protein_g: Number(m.protein_g ?? 0),
      carbs_g: Number(m.carbs_g ?? 0),
      fat_g: Number(m.fat_g ?? 0),
    },
  }));
}

export function planForDate(date = new Date()) {
  const wd = isoWeekday(date);
  const dietType = dietTypeForWeekday(wd);
  const tomorrow = new Date(date);
  tomorrow.setDate(date.getDate() + 1);
  const wdT = isoWeekday(tomorrow);
  const key = localDateKey(date);

  // Diet: a permanent override and/or this date's rows fold onto the scaffold.
  // A full payload replaces the day; a delta ({op}) merges onto the current base
  // (the permanent override if there is one, else the standing scaffold).
  const datedDietRows = normRows(_dietDated.get(key));
  let dietPayload = null;
  if (_dietOverride || datedDietRows.length) {
    const base = _dietOverride || scaffoldDietPayload(date);
    dietPayload = datedDietRows.length ? foldPlanPayloads("diet", base, datedDietRows) : _dietOverride;
  }
  const meals = (dietPayload && overrideMeals(dietPayload)) || mealsFor(dietType);

  // Gym: this date's rows fold onto the standing workout (no permanent gym plan).
  const datedGymRows = normRows(_gymDated.get(key));
  let datedWorkout = null;
  if (datedGymRows.length) {
    const gymPayload = foldPlanPayloads("gym", scaffoldGymPayload(date), datedGymRows);
    datedWorkout = gymWorkoutFromPayload(gymPayload, wd);
  }

  return {
    date,
    weekday: wd,
    weekdayName: WEEKDAY_NAMES[wd],
    dietType,
    dietLabel: dietType === "paneer-soy" ? "Paneer-Soy day" : "Soybean day",
    workout: datedWorkout || WORKOUTS[WORKOUT_BY_WEEKDAY[wd]],
    meals,
    customDiet: Boolean(dietPayload),
    customWorkout: Boolean(datedWorkout),
    supplements: supplementsFor(wd),
    water: WATER,
    macroTargets: resolveTargets(meals, dietPayload),
    tomorrowName: WEEKDAY_NAMES[wdT],
    tomorrowDietLabel: dietTypeForWeekday(wdT) === "paneer-soy" ? "Paneer-Soy day" : "Soybean day",
    prepForTomorrow: prepForTomorrow(dietTypeForWeekday(wdT)),
  };
}

// ---- Gym: structured exercises from the workout scaffold ----
// Keyword rules map a free-text exercise name to its primary muscle group, so
// plan items like "DB Romanian deadlift 2×10" resolve without an exact-name table.
const MUSCLE_RULES = [
  [/treadmill|walk|run\b|running|cardio|cycle|cycling|steps|elliptical|cooldown|warm/i, "cardio"],
  [/plank|dead\s*bug|crunch|core|\babs?\b|hollow|russian twist/i, "core"],
  [/romanian|rdl|leg curl|hamstring/i, "hamstrings"],
  [/leg press|squat|lunge|leg extension|quad/i, "quads"],
  [/calf|calves/i, "calves"],
  [/glute|hip thrust/i, "glutes"],
  [/chest press|bench|incline.*press|push[- ]?up|pec|chest fly|\bfly\b/i, "chest"],
  [/lat pulldown|pull[- ]?up|pull[- ]?down|\brow\b|cable row|\bback\b|deadlift/i, "back"],
  [/shoulder press|overhead press|lateral raise|\bdelt|\bohp\b|shoulder/i, "shoulders"],
  [/triceps|pushdown|\bdip/i, "triceps"],
  [/\bcurl\b|biceps/i, "biceps"],
];

// Resolve a primary muscle group for an exercise name (defaults to "other").
export function muscleFor(name) {
  const n = String(name || "");
  for (const [rx, m] of MUSCLE_RULES) if (rx.test(n)) return m;
  return "other";
}

// Parse a workout's free-text items into structured exercises. Items with a
// "S×R" pattern ("Leg press 2×12", "Plank 2×30s", "Dead bug 2×10/side") become
// loggable exercises with `sets` prescribed rows; everything else (warmup,
// cooldown, "either one counts") becomes a cardio/note row with no sets.
export function prescribedExercises(workout) {
  const items = Array.isArray(workout?.items) ? workout.items : [];
  return items.map((raw, i) => {
    const text = String(raw).trim();
    const m = text.match(/^(.*?)[\s,]+(\d+)\s*[×x]\s*(\d+)\s*(s|sec|secs)?\b/i);
    if (m) {
      const name = m[1].replace(/[•\-–—]\s*$/, "").trim();
      const muscle = muscleFor(name);
      return {
        key: `ex${i}`, name, raw: text,
        kind: muscle === "cardio" ? "cardio" : "strength",
        sets: Number(m[2]), reps: Number(m[3]), repsUnit: m[4] ? "sec" : "reps",
        muscle,
        loggable: muscle !== "cardio",
      };
    }
    return { key: `ex${i}`, name: text, raw: text, kind: "note", sets: 0, reps: 0, repsUnit: "", muscle: muscleFor(text), loggable: false };
  });
}
