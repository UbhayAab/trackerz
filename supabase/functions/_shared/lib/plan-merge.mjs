// One-shot plan edits: fold a small DELTA ("add a salad bowl at 4pm", "swap
// today's workout for cardio", "drop the banana snack") onto a base plan
// document, so the model never has to re-emit the whole day's plan. Pure (no DOM,
// no Supabase) so it's tested directly and reused by the browser plan resolver.
//
// A stored user_plans.payload is EITHER a full document (has `meals` / workout
// fields, no `op`) OR a delta (`{ op, … }`). foldPlanPayloads() walks a scope's
// rows oldest→newest over a base: a full document RESETS the accumulator, a delta
// MERGES onto it. That preserves "a full override replaces the day" while letting
// deltas stack ("add salad" then later "drop banana").

const MEAL_SLOTS = ["breakfast", "lunch", "snack", "dinner", "other"];

export function isPlanDelta(payload) {
  return Boolean(
    payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.op === "string",
  );
}

function normMeal(m = {}) {
  return {
    time: m.time || "",
    slot: MEAL_SLOTS.includes(m.slot) ? m.slot : "other",
    name: m.name || m.meal_name || "Meal",
    detail: m.detail || m.description || "",
    calories: Number(m.calories ?? m.calories_estimate ?? 0) || 0,
    protein_g: Number(m.protein_g ?? 0) || 0,
    carbs_g: Number(m.carbs_g ?? 0) || 0,
    fat_g: Number(m.fat_g ?? 0) || 0,
  };
}

// A `match` is either a meal slot ("snack") or a case-insensitive substring of
// the meal name/detail ("banana").
function matchesMeal(meal, match) {
  const m = String(match || "").toLowerCase().trim();
  if (!m) return false;
  if (MEAL_SLOTS.includes(m)) return meal.slot === m;
  return String(meal.name || "").toLowerCase().includes(m)
    || String(meal.detail || "").toLowerCase().includes(m);
}

function sumMeals(meals) {
  return meals.reduce((t, m) => ({
    calories: t.calories + (Number(m.calories) || 0),
    protein_g: t.protein_g + (Number(m.protein_g) || 0),
    carbs_g: t.carbs_g + (Number(m.carbs_g) || 0),
    fat_g: t.fat_g + (Number(m.fat_g) || 0),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
}

// Targets track the meal sum (calories/protein/carbs/fat) but keep any non-macro
// keys (fiber_g, water_ml) from the base; an explicit `set_targets` wins outright.
function recomputeTargets(meals, prevTargets = {}, explicit = null) {
  const sum = sumMeals(meals);
  const targets = {
    ...prevTargets,
    calories: Math.round(sum.calories),
    protein_g: Math.round(sum.protein_g),
    carbs_g: Math.round(sum.carbs_g),
    fat_g: Math.round(sum.fat_g),
  };
  if (explicit && typeof explicit === "object") Object.assign(targets, explicit);
  return targets;
}

export function applyDietDelta(base = {}, delta = {}) {
  const meals = Array.isArray(base.meals) ? base.meals.map(normMeal) : [];
  const prevTargets = { ...(base.targets || {}) };
  let next = meals;

  switch (delta.op) {
    case "add_meal":
      next = [...meals, normMeal(delta.meal || delta)];
      break;
    case "remove_meal": {
      const kept = meals.filter((m) => !matchesMeal(m, delta.match));
      next = kept; // no match -> no-op (kept === all)
      break;
    }
    case "replace_meal": {
      const nm = normMeal(delta.meal || {});
      let replaced = false;
      next = meals.map((m) => {
        if (!replaced && matchesMeal(m, delta.match)) { replaced = true; return nm; }
        return m;
      });
      if (!replaced) next = [...next, nm];
      break;
    }
    case "set_targets":
      return { ...base, meals, targets: recomputeTargets(meals, prevTargets, delta.targets || {}) };
    default:
      // unknown op -> leave the plan unchanged
      return { ...base, meals, targets: prevTargets };
  }
  return { ...base, meals: next, targets: recomputeTargets(next, prevTargets) };
}

function normWorkout(w = {}) {
  return {
    name: w.name || "Custom workout",
    kind: w.kind || "gym",
    duration_min: Number(w.duration_min) || 50,
    items: Array.isArray(w.items) ? w.items.map(String) : [],
    rules: w.rules || "",
  };
}

export function applyGymDelta(base = {}, delta = {}) {
  const wk = normWorkout(base);
  switch (delta.op) {
    case "replace_workout":
      return normWorkout(delta.workout || delta);
    case "add_exercise": {
      const ex = String(delta.exercise || delta.item || "").trim();
      return ex ? { ...wk, items: [...wk.items, ex] } : wk;
    }
    case "remove_exercise": {
      const m = String(delta.match || "").toLowerCase().trim();
      return m ? { ...wk, items: wk.items.filter((it) => !String(it).toLowerCase().includes(m)) } : wk;
    }
    default:
      return wk;
  }
}

export function applyPlanDelta(kind, base, delta) {
  return kind === "gym" ? applyGymDelta(base, delta) : applyDietDelta(base, delta);
}

// Fold a scope's stored payloads (oldest→newest) onto a base document. A full
// (non-delta) payload resets the accumulator; a delta merges onto it.
export function foldPlanPayloads(kind, base, payloads = []) {
  let acc = base;
  for (const p of payloads) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    acc = isPlanDelta(p) ? applyPlanDelta(kind, acc, p) : p;
  }
  return acc;
}
