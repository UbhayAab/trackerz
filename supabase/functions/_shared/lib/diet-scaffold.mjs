// Ubhay's fixed 4-week diet / workout / supplement scaffold — pure data + small
// resolvers, extracted from src/domain/diet/plan.js so BOTH the browser plan
// resolver and the plan-merge layer can build a "base plan document" for a date
// without duplicating the data. No DOM, no Supabase — importable by tests.
//
// The same 7-day cycle repeats every week, keyed off the ISO weekday
// (1=Mon … 7=Sun). Wed(3) & Sat(6) are Paneer-Soy days; the rest Soybean.

// Fallback only. Real daily macro targets are derived from the scaffold (the sum
// of the day's planned meals). fiber_g / water_ml aren't carried on meals, so
// they fall back to these; an explicit { targets } override wins.
export const MACRO_TARGETS = Object.freeze({
  calories: 2000, protein_g: 162, carbs_g: 188, fat_g: 77, fiber_g: 47, water_ml: 3450,
});

// Sum a rich meal list's macros (m.macros.*) — the scaffold IS the source of
// truth for targets.
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

export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1; // JS 0=Sun -> ISO 1=Mon … 7=Sun
}

export function dietTypeForWeekday(wd) {
  return (wd === 3 || wd === 6) ? "paneer-soy" : "soybean";
}

export const WORKOUTS = {
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
export const WORKOUT_BY_WEEKDAY = { 1: "A", 2: "cardio", 3: "cardio", 4: "cardio", 5: "B", 6: "A", 7: "B" };

// Per-meal macro estimates; the four meals sum to roughly the daily targets.
export function mealsFor(dietType) {
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

export const WATER = [
  { id: "water-wake", time: "07:00", label: "Wake-up", ml: 500 },
  { id: "water-shake", time: "08:00", label: "With shake", ml: 500 },
  { id: "water-mid", time: "11:00", label: "Mid-morning", ml: 750 },
  { id: "water-noon", time: "15:00", label: "Afternoon", ml: 750 },
  { id: "water-workout", time: "18:00", label: "Workout / walk", ml: 500 },
  { id: "water-psyllium", time: "22:45", label: "With psyllium", ml: 450 },
];

export function supplementsFor(wd) {
  const b12Day = (wd === 1 || wd === 3 || wd === 5);
  // Whey is intentionally NOT here — it IS the 08:00 protein shake meal, not a
  // second supplement.
  const list = [
    { id: "sup-d3", time: "20:00", name: "Vitamin D3 2000 IU", note: "with dinner" },
    { id: "sup-omega", time: "20:00", name: "Omega-3 (1000 mg EPA+DHA)", note: "with dinner" },
    { id: "sup-mg", time: "22:00", name: "Magnesium glycinate 200 mg", note: "" },
    { id: "sup-psyllium", time: "22:45", name: "Psyllium husk 5 g", note: "+400–500 ml water" },
  ];
  if (b12Day) list.unshift({ id: "sup-b12", time: "08:15", name: "Vitamin B12 1000 mcg", note: "after shake (Mon/Wed/Fri)" });
  return list;
}

export function prepForTomorrow(tomorrowDietType) {
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

// ---- payload-shaped base documents (for plan-merge folding) ----
// The user_plans.payload contract stores FLAT-macro meals ({calories, protein_g,
// carbs_g, fat_g}) — not the rich {macros:{…}} shape. These builders return that
// flat payload shape so a delta ("add a salad bowl") can be folded onto the
// standing scaffold for a specific date.

export function scaffoldDietPayload(date = new Date()) {
  const wd = isoWeekday(date);
  const rich = mealsFor(dietTypeForWeekday(wd));
  const meals = rich.map((m) => ({
    time: m.time, slot: m.slot, name: m.name, detail: m.detail,
    calories: m.macros.calories, protein_g: m.macros.protein_g, carbs_g: m.macros.carbs_g, fat_g: m.macros.fat_g,
  }));
  const sum = sumMealMacros(rich);
  return {
    meals,
    targets: { calories: sum.calories, protein_g: sum.protein_g, carbs_g: sum.carbs_g, fat_g: sum.fat_g, fiber_g: MACRO_TARGETS.fiber_g, water_ml: MACRO_TARGETS.water_ml },
  };
}

export function scaffoldGymPayload(date = new Date()) {
  const wd = isoWeekday(date);
  const w = WORKOUTS[WORKOUT_BY_WEEKDAY[wd]];
  return { name: w.name, kind: w.kind, duration_min: w.duration_min, items: [...w.items], rules: w.rules };
}
