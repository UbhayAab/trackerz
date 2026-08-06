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
//
// ---------------------------------------------------------------------------
// Three guards here exist because editing a plan was more dangerous than adding
// one, and all three were silent:
//
// 1. `matchesMeal` was an UNANCHORED SUBSTRING with no minimum length, so
//    { op:"remove_meal", match:"e" } matched nearly every meal in the plan and
//    deleted the first one it found with no signal that it had picked. A match is
//    now >= 3 characters and matched on WORD BOUNDARIES.
// 2. A `remove_meal` / `remove_exercise` that matches MORE THAN ONE row now
//    REFUSES and reports the count. Guessing which of two matches the user meant
//    is the one thing an edit must never do - the wrong meal disappearing is
//    indistinguishable from the right one disappearing until the totals are read.
// 3. `recomputeTargets` DERIVED the day's calorie and protein TARGETS from the
//    surviving meal sum. A target is a GOAL and a meal list is a PLAN; they are
//    different objects. One bad delta therefore silently rewrote the goal the app
//    measures the user against, and an empty meal list produced a 0 kcal target
//    that then rendered as a measured zero. Targets now change ONLY through an
//    explicit `set_targets`.
//
// Every delta op returns { plan, applied, matched_count, reason } so a refusal is
// a value the UI can surface, not a silent no-op. foldPlanPayloads() still returns
// the folded DOCUMENT (its callers resolve a plan, not a report);
// foldPlanPayloadsDetailed() returns both.
// ---------------------------------------------------------------------------

const MEAL_SLOTS = ["breakfast", "lunch", "snack", "dinner", "other"];

// A free-text `match` shorter than this cannot identify anything. "e" matched
// every meal; "gym" is the shortest thing anyone actually types.
export const MIN_MATCH_LENGTH = 3;

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

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary containment. Anchored on both ends so "e" cannot match "Shake"
// and "oat" cannot match "goat", while "salad bowl" still matches "Salad bowl".
function hasWord(haystack, needle) {
  if (!haystack || !needle) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`, "i").test(String(haystack));
}

// A `match` is either a meal slot ("snack") or a word-boundary match against the
// meal name/detail ("banana"). Returns false for anything too short to identify a
// meal - see guard 1 above.
export function matchesMeal(meal, match) {
  const m = String(match || "").toLowerCase().trim();
  if (!m) return false;
  if (MEAL_SLOTS.includes(m)) return meal.slot === m;
  if (m.length < MIN_MATCH_LENGTH) return false;
  return hasWord(meal.name, m) || hasWord(meal.detail, m);
}

// Is this match string usable at all? Distinguishes "you gave me nothing to work
// with" from "nothing matched", which are different answers for the user.
function matchUsable(match) {
  const m = String(match || "").toLowerCase().trim();
  if (!m) return false;
  if (MEAL_SLOTS.includes(m)) return true;
  return m.length >= MIN_MATCH_LENGTH;
}

function sumMeals(meals) {
  return meals.reduce((t, m) => ({
    calories: t.calories + (Number(m.calories) || 0),
    protein_g: t.protein_g + (Number(m.protein_g) || 0),
    carbs_g: t.carbs_g + (Number(m.carbs_g) || 0),
    fat_g: t.fat_g + (Number(m.fat_g) || 0),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
}

// Exported because the diff card and the diet hub both want "what does this plan
// add up to" - which is a real, useful number. It is just not the TARGET.
export { sumMeals };

function dietOut(base, meals, targets, result) {
  return { plan: { ...base, meals, targets }, ...result };
}

export function applyDietDelta(base = {}, delta = {}) {
  const meals = Array.isArray(base.meals) ? base.meals.map(normMeal) : [];
  // Targets are carried through UNCHANGED by every op except set_targets.
  const targets = { ...(base.targets || {}) };

  switch (delta.op) {
    case "add_meal":
      return dietOut(base, [...meals, normMeal(delta.meal || delta)], targets,
        { applied: true, matched_count: 1, reason: null });

    case "remove_meal": {
      if (!matchUsable(delta.match)) {
        return dietOut(base, meals, targets, { applied: false, matched_count: 0, reason: "match_too_short" });
      }
      const hits = meals.filter((m) => matchesMeal(m, delta.match));
      if (!hits.length) {
        return dietOut(base, meals, targets, { applied: false, matched_count: 0, reason: "no_match" });
      }
      if (hits.length > 1) {
        // REFUSE, do not guess. The UI surfaces the names so the user picks.
        return dietOut(base, meals, targets, {
          applied: false, matched_count: hits.length, reason: "ambiguous_match",
          candidates: hits.map((m) => m.name),
        });
      }
      return dietOut(base, meals.filter((m) => m !== hits[0]), targets,
        { applied: true, matched_count: 1, reason: null });
    }

    case "replace_meal": {
      if (!matchUsable(delta.match)) {
        return dietOut(base, meals, targets, { applied: false, matched_count: 0, reason: "match_too_short" });
      }
      const hits = meals.filter((m) => matchesMeal(m, delta.match));
      if (!hits.length) {
        // Used to APPEND. "Replace the dinner" when there is no dinner then added
        // a second dinner nobody asked for, and the plan grew on every retry.
        return dietOut(base, meals, targets, { applied: false, matched_count: 0, reason: "no_match" });
      }
      if (hits.length > 1) {
        return dietOut(base, meals, targets, {
          applied: false, matched_count: hits.length, reason: "ambiguous_match",
          candidates: hits.map((m) => m.name),
        });
      }
      const nm = normMeal(delta.meal || {});
      return dietOut(base, meals.map((m) => (m === hits[0] ? nm : m)), targets,
        { applied: true, matched_count: 1, reason: null });
    }

    case "set_targets": {
      // The ONLY op that may move a target.
      const explicit = delta.targets && typeof delta.targets === "object" && !Array.isArray(delta.targets)
        ? delta.targets : null;
      if (!explicit || !Object.keys(explicit).length) {
        return dietOut(base, meals, targets, { applied: false, matched_count: 0, reason: "no_targets_given" });
      }
      return dietOut(base, meals, { ...targets, ...explicit },
        { applied: true, matched_count: Object.keys(explicit).length, reason: null });
    }

    default:
      return dietOut(base, meals, targets, { applied: false, matched_count: 0, reason: "unknown_op" });
  }
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

function gymOut(plan, result) {
  return { plan, ...result };
}

export function applyGymDelta(base = {}, delta = {}) {
  const wk = normWorkout(base);
  switch (delta.op) {
    case "replace_workout":
      return gymOut(normWorkout(delta.workout || delta), { applied: true, matched_count: 1, reason: null });

    case "add_exercise": {
      const ex = String(delta.exercise || delta.item || "").trim();
      if (!ex) return gymOut(wk, { applied: false, matched_count: 0, reason: "missing_exercise" });
      return gymOut({ ...wk, items: [...wk.items, ex] }, { applied: true, matched_count: 1, reason: null });
    }

    case "remove_exercise": {
      const m = String(delta.match || "").toLowerCase().trim();
      if (m.length < MIN_MATCH_LENGTH) return gymOut(wk, { applied: false, matched_count: 0, reason: "match_too_short" });
      const hits = wk.items.filter((it) => hasWord(it, m));
      if (!hits.length) return gymOut(wk, { applied: false, matched_count: 0, reason: "no_match" });
      if (hits.length > 1) {
        return gymOut(wk, { applied: false, matched_count: hits.length, reason: "ambiguous_match", candidates: hits });
      }
      return gymOut({ ...wk, items: wk.items.filter((it) => it !== hits[0]) },
        { applied: true, matched_count: 1, reason: null });
    }

    case "replace_exercise": {
      const m = String(delta.match || "").toLowerCase().trim();
      const ex = String(delta.exercise || "").trim();
      if (!ex) return gymOut(wk, { applied: false, matched_count: 0, reason: "missing_exercise" });
      if (m.length < MIN_MATCH_LENGTH) return gymOut(wk, { applied: false, matched_count: 0, reason: "match_too_short" });
      const hits = wk.items.filter((it) => hasWord(it, m));
      if (!hits.length) return gymOut(wk, { applied: false, matched_count: 0, reason: "no_match" });
      if (hits.length > 1) {
        return gymOut(wk, { applied: false, matched_count: hits.length, reason: "ambiguous_match", candidates: hits });
      }
      return gymOut({ ...wk, items: wk.items.map((it) => (it === hits[0] ? ex : it)) },
        { applied: true, matched_count: 1, reason: null });
    }

    default:
      return gymOut(wk, { applied: false, matched_count: 0, reason: "unknown_op" });
  }
}

export function applyPlanDelta(kind, base, delta) {
  return kind === "gym" ? applyGymDelta(base, delta) : applyDietDelta(base, delta);
}

// Fold a scope's stored payloads (oldest→newest) onto a base document. A full
// (non-delta) payload resets the accumulator; a delta merges onto it. A REFUSED
// delta leaves the accumulator exactly as it was.
export function foldPlanPayloadsDetailed(kind, base, payloads = []) {
  let acc = base;
  const results = [];
  for (const p of payloads) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    if (!isPlanDelta(p)) { acc = p; results.push({ op: null, applied: true, matched_count: null, reason: null }); continue; }
    const out = applyPlanDelta(kind, acc, p);
    acc = out.plan;
    results.push({ op: p.op, applied: out.applied, matched_count: out.matched_count, reason: out.reason, candidates: out.candidates });
  }
  return { plan: acc, results };
}

export function foldPlanPayloads(kind, base, payloads = []) {
  return foldPlanPayloadsDetailed(kind, base, payloads).plan;
}
