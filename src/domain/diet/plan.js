// Ubhay's fixed 4-week diet / workout / supplement plan. Pure data + a day
// resolver — no DOM, no Supabase, so it stays importable by the UI and by tests.
// The same 7-day cycle repeats every week, so we key everything off the weekday
// (ISO: 1=Mon … 7=Sun). Wed(3) & Sat(6) are Paneer-Soy days; the rest Soybean.

// Fallback only. The REAL daily macro targets are derived from the scaffold —
// i.e. the sum of the day's planned meals — so "the values in the scaffold
// determine the overall values". fiber_g / water_ml aren't carried on meals, so
// they fall back to these. An explicit { targets } in a user plan override wins.
export const MACRO_TARGETS = Object.freeze({
  calories: 2000, protein_g: 162, carbs_g: 188, fat_g: 77, fiber_g: 47, water_ml: 3450,
});

// Sum a meal list's macros — the scaffold IS the source of truth for targets.
export function sumMealMacros(meals) {
  const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const m of meals || []) {
    const x = m.macros || {};
    t.calories += Number(x.calories || 0);
    t.protein_g += Number(x.protein_g || 0);
    t.carbs_g += Number(x.carbs_g || 0);
    t.fat_g += Number(x.fat_g || 0);
  }
  return { calories: Math.round(t.calories), protein_g: Math.round(t.protein_g), carbs_g: Math.round(t.carbs_g), fat_g: Math.round(t.fat_g) };
}

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
// exactly those dates' plan (NOT a log/tick). Keyed by local "YYYY-MM-DD". sync.js
// builds these from user_plans rows whose scope is a comma-separated date list.
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

const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1; // JS 0=Sun -> ISO 1=Mon … 7=Sun
}

function dietTypeForWeekday(wd) {
  return (wd === 3 || wd === 6) ? "paneer-soy" : "soybean";
}

const WORKOUTS = {
  A: {
    id: "workout-a", name: "Workout A", kind: "gym", duration_min: 50,
    items: ["Treadmill 8 min easy", "Leg press 2×12", "Machine chest press 2×10", "Lat pulldown 2×10",
      "Seated cable row 2×10", "DB Romanian deadlift 2×10", "DB lateral raise 2×15", "Plank 2×30s", "Cooldown walk 5 min"],
    rules: "No failure · no PR · no HIIT · 90s rest · ~50–60% of old weights",
  },
  B: {
    id: "workout-b", name: "Workout B", kind: "gym", duration_min: 50,
    items: ["Treadmill 8 min easy", "Goblet squat 2×10", "Incline DB press 2×10", "Seated cable row 2×10",
      "Leg curl 2×12", "Machine shoulder press 2×10", "Cable triceps pushdown 2×12", "DB curl 2×12", "Dead bug 2×10/side", "Cooldown walk 5 min"],
    rules: "No failure · no PR · no HIIT · 90s rest",
  },
  cardio: {
    id: "cardio", name: "Cardio — forgiven day", kind: "cardio", duration_min: 40,
    items: ["10,000 steps walk", "— or a gym session (either one counts)"],
    rules: "Forgiven day: hit ~10k steps OR train at the gym. Both count.",
  },
};
// Focus (strength) days: Mon, Fri, Sat, Sun (Workout A/B alternating).
// Forgiven cardio days: Tue, Wed, Thu (10k steps OR gym — either counts).
const WORKOUT_BY_WEEKDAY = { 1: "A", 2: "cardio", 3: "cardio", 4: "cardio", 5: "B", 6: "A", 7: "B" };

// Per-meal macro estimates; the four meals sum to roughly the daily targets.
function mealsFor(dietType) {
  const paneerSoy = dietType === "paneer-soy";
  return [
    { id: "meal-shake", time: "08:00", slot: "breakfast", name: "Protein milk shake",
      detail: `2 scoops whey + ${paneerSoy ? "200" : "250"} ml toned milk + 200–300 ml water`,
      macros: { calories: 365, protein_g: 56, carbs_g: 15, fat_g: 7 } },
    { id: "meal-eggcurry", time: "13:00", slot: "lunch", name: "Egg curry + 2 rotis",
      detail: paneerSoy ? "3 whole eggs + 4 whites · 2 rotis (60 g atta)" : "4 whole eggs + 3 whites · 2 rotis (60 g atta)",
      macros: { calories: 520, protein_g: 43, carbs_g: 52, fat_g: 24 } },
    { id: "meal-fruit", time: "17:00", slot: "snack", name: "Banana + guava",
      detail: "1 banana (~120 g) + 100 g guava",
      macros: { calories: 150, protein_g: 2, carbs_g: 36, fat_g: 1 } },
    { id: "meal-salad", time: "20:00", slot: "dinner", name: "Big salad bowl + seeds",
      detail: paneerSoy
        ? "Base veg + 70 g soybeans + 40 g paneer + Greek-yogurt dressing + seed mix"
        : "Base veg + 120 g soybeans + Greek-yogurt dressing + seed mix",
      macros: paneerSoy ? { calories: 760, protein_g: 52, carbs_g: 46, fat_g: 38 } : { calories: 730, protein_g: 50, carbs_g: 50, fat_g: 35 } },
  ];
}

const WATER = [
  { id: "water-wake", time: "07:00", label: "Wake-up", ml: 500 },
  { id: "water-shake", time: "08:00", label: "With shake", ml: 500 },
  { id: "water-mid", time: "11:00", label: "Mid-morning", ml: 750 },
  { id: "water-noon", time: "15:00", label: "Afternoon", ml: 750 },
  { id: "water-workout", time: "18:00", label: "Workout / walk", ml: 500 },
  { id: "water-psyllium", time: "22:45", label: "With psyllium", ml: 450 },
];

function supplementsFor(wd) {
  const b12Day = (wd === 1 || wd === 3 || wd === 5);
  // Whey is intentionally NOT here — it IS the 08:00 protein shake meal, not a
  // second supplement. Listing it twice was the duplication.
  const list = [
    { id: "sup-d3", time: "20:00", name: "Vitamin D3 2000 IU", note: "with dinner" },
    { id: "sup-omega", time: "20:00", name: "Omega-3 (1000 mg EPA+DHA)", note: "with dinner" },
    { id: "sup-mg", time: "22:00", name: "Magnesium glycinate 200 mg", note: "" },
    { id: "sup-psyllium", time: "22:45", name: "Psyllium husk 5 g", note: "+400–500 ml water" },
  ];
  if (b12Day) list.unshift({ id: "sup-b12", time: "08:15", name: "Vitamin B12 1000 mcg", note: "after shake (Mon/Wed/Fri)" });
  return list;
}

function prepForTomorrow(tomorrowDietType) {
  const prep = [
    { id: "prep-soak", text: `Soak 50 g dry soybeans overnight (tomorrow needs ${tomorrowDietType === "paneer-soy" ? "70 g soy + 40 g paneer" : "120 g soybeans"})` },
    { id: "prep-eggs", text: `Keep eggs ready (${tomorrowDietType === "paneer-soy" ? "3 whole + 4 whites" : "4 whole + 3 whites"})` },
    { id: "prep-fruit", text: "Set aside 1 banana + 100 g guava" },
    { id: "prep-salad", text: "Wash & chop salad veg (cucumber, tomato, capsicum, carrot, greens)" },
    { id: "prep-yogurt", text: "Chill 200 g Greek yogurt / hung curd; soak chia in it 10 min before dinner" },
  ];
  if (tomorrowDietType === "paneer-soy") prep.push({ id: "prep-paneer", text: "Keep 40 g paneer ready to dry-roast" });
  return prep;
}

export function planForDate(date = new Date()) {
  const wd = isoWeekday(date);
  const dietType = dietTypeForWeekday(wd);
  const tomorrow = new Date(date);
  tomorrow.setDate(date.getDate() + 1);
  const wdT = isoWeekday(tomorrow);
  // Resolution order: a date-scoped override for THIS day wins, then the standing
  // permanent override, then the fixed weekday default.
  const key = localDateKey(date);
  const dietPayload = _dietDated.get(key) || _dietOverride;
  const meals = overrideMeals(dietPayload) || mealsFor(dietType);
  const datedWorkout = gymWorkoutFromPayload(_gymDated.get(key), wd);
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
