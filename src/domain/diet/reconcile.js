// Reconcile a day's LOGGED rows (food / workout / hydration) against that day's
// plan items, so anything you captured free-form ("had egg curry n rotis", "did
// legs at gym", "cake last night") auto-ticks the matching plan check-off instead
// of waiting for a manual tap. Pure module: no DOM, no Supabase — importable by
// the UI and by tests.
//
// Output per item id: { source: "auto"|"suggested", confidence, recordId, table }.
// "auto"  = strong match (the UI ticks it outright).
// "suggested" = weak match (the UI shows a faint ✓ to confirm).
// Anything not matched is simply absent (and the logged row still shows up in the
// day's macro gauges / feed — a non-plan food like cake just isn't a check-off).

import { isoWeekday, prescribedExercises, muscleFor } from "./plan.js";

const AUTO_THRESHOLD = 0.6;
const SUGGEST_THRESHOLD = 0.3;

// Words that carry no dish signal — stripped before token matching so "had a big
// bowl of egg curry" matches on {egg,curry}, not on {had,big,bowl,of}.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "with", "had", "have", "ate", "eat", "eaten",
  "for", "in", "at", "on", "my", "some", "big", "bowl", "plate", "glass", "cup",
  "to", "i", "me", "was", "were", "is", "today", "yesterday", "night", "morning",
  "evening", "afternoon", "those", "that", "this", "it", "auto", "from", "spend",
]);

// Pure measurement/unit noise — numbers and units shouldn't drive a dish match.
const UNIT_RE = /^(\d+|g|kg|ml|l|mg|mcg|iu|scoops?|pcs?|pieces?|rs|x|min|mins)$/i;

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !UNIT_RE.test(t))
    .map(stem);
}

// Crude singular/plural fold so "rotis"~"roti", "eggs"~"egg", "seeds"~"seed".
function stem(t) {
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

// A meal's matchable tokens: name tokens are the strong signal, detail tokens a
// weaker secondary signal.
function mealKeywords(meal) {
  const name = new Set(tokenize(meal.name));
  const detail = new Set(tokenize(meal.detail));
  for (const t of name) detail.delete(t);
  return { name, detail };
}

function overlap(setA, tokens) {
  let hits = 0;
  for (const t of tokens) if (setA.has(t)) hits++;
  return hits;
}

// Score one logged food row against one plan meal (0..1).
export function scoreFoodToMeal(food, meal) {
  const text = `${food.meal_name || ""} ${food.description || ""}`;
  const tokens = new Set(tokenize(text));
  if (!tokens.size) return 0;
  const kw = mealKeywords(meal);

  let score = 0;
  // Name tokens dominate: fraction of the meal's name words that appear.
  if (kw.name.size) score += 0.7 * (overlap(kw.name, tokens) / kw.name.size);
  // Detail tokens add a smaller, capped boost.
  if (kw.detail.size) score += Math.min(0.3, 0.12 * overlap(kw.detail, tokens));
  // Same meal slot is corroborating evidence (and lets "had dinner" alone land
  // as a suggestion for the planned dinner).
  if (food.meal_slot && meal.slot && food.meal_slot === meal.slot) score += 0.3;

  return Math.min(1, score);
}

function classify(confidence) {
  if (confidence >= AUTO_THRESHOLD) return "auto";
  if (confidence >= SUGGEST_THRESHOLD) return "suggested";
  return null;
}

// Greedily assign each logged food to its best unclaimed meal. One log can tick at
// most one meal; one meal is ticked by at most one log (the strongest).
function reconcileFood(meals, foodLogs) {
  const out = {};
  const pairs = [];
  for (const f of foodLogs || []) {
    for (const m of meals || []) {
      const confidence = scoreFoodToMeal(f, m);
      if (classify(confidence)) pairs.push({ f, m, confidence });
    }
  }
  pairs.sort((a, b) => b.confidence - a.confidence);
  const claimedMeals = new Set();
  const claimedLogs = new Set();
  for (const p of pairs) {
    if (claimedMeals.has(p.m.id) || claimedLogs.has(p.f.id)) continue;
    claimedMeals.add(p.m.id);
    claimedLogs.add(p.f.id);
    out[p.m.id] = { source: classify(p.confidence), confidence: Number(p.confidence.toFixed(3)), recordId: p.f.id, table: "food_logs" };
  }
  return out;
}

// Any workout row on the day ticks the day's single workout item — presence is the
// signal (one gym session = the day's workout). Cardio/walk rows count too.
function reconcileWorkout(plan, workoutLogs) {
  const out = {};
  const rows = workoutLogs || [];
  if (!rows.length || !plan.workout) return out;
  out[plan.workout.id] = { source: "auto", confidence: 1, recordId: rows[0].id, table: "workout_logs" };
  return out;
}

// Per-EXERCISE gym auto-check: match a captured workout's logged sets to the
// prescribed exercises so "did legs — leg press 3×12, leg curl 3×12" ticks those
// exercises on the gym checklist (the diet hub's analogue, but per ex.key not the
// whole-day workout item). Gated by muscle group so "leg press" (quads) never
// ticks "leg curl" (hamstrings); scored by prescribed-name token coverage so a
// single shared generic word ("press") stays a suggestion, not an auto-tick.
export function reconcileExercises(workout, workoutLogs, date) {
  const out = {};
  const prescribed = prescribedExercises(workout).filter((e) => e.loggable);
  if (!prescribed.length) return out;
  // Flatten the day's logged sets, carrying their parent workout_logs row id.
  const logged = [];
  for (const w of logsOnDate(workoutLogs, date)) {
    for (const s of Array.isArray(w.sets) ? w.sets : []) {
      const nm = s && (s.exercise || s.name);
      if (nm) logged.push({ name: nm, muscle: s.muscle || muscleFor(nm), recordId: w.id });
    }
  }
  if (!logged.length) return out;
  for (const ex of prescribed) {
    const exTokens = new Set(tokenize(ex.name));
    if (!exTokens.size) continue;
    let best = null;
    for (const s of logged) {
      // Muscle gate: only compare same-muscle lifts (or when a muscle is unknown).
      if (ex.muscle && s.muscle && ex.muscle !== s.muscle) continue;
      const hits = overlap(exTokens, new Set(tokenize(s.name)));
      if (!hits) continue;
      const score = hits / exTokens.size; // fraction of the prescribed name covered
      if (!best || score > best.score) best = { score, recordId: s.recordId };
    }
    const source = best && classify(best.score);
    if (source) out[ex.key] = { source, confidence: Number(best.score.toFixed(3)), recordId: best.recordId, table: "workout_logs" };
  }
  return out;
}

// Match hydration rows to water plan items by exact ml (a 500 ml log ticks a 500
// ml slot). Each logged row claims at most one slot.
function reconcileHydration(plan, hydrationLogs) {
  const out = {};
  const rows = [...(hydrationLogs || [])];
  for (const w of plan.water || []) {
    const idx = rows.findIndex((r) => Number(r.ml) === Number(w.ml));
    if (idx >= 0) {
      out[w.id] = { source: "auto", confidence: 1, recordId: rows[idx].id, table: "hydration_logs" };
      rows.splice(idx, 1);
    }
  }
  return out;
}

// Reconcile every domain for a single day's plan. `logs` are already filtered to
// the plan's date by the caller.
export function reconcilePlan(plan, { foodLogs = [], workoutLogs = [], hydrationLogs = [] } = {}) {
  return {
    ...reconcileFood(plan.meals, foodLogs),
    ...reconcileWorkout(plan, workoutLogs),
    ...reconcileHydration(plan, hydrationLogs),
  };
}

// True when `iso` falls on the same local calendar day as `date`.
export function sameLocalDay(iso, date) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate();
}

// Convenience for callers that hold a flat log list: keep only rows on `date`.
export function logsOnDate(rows, date) {
  return (rows || []).filter((r) => sameLocalDay(r.occurred_at, date));
}

// Re-exported so the panel can share one weekday helper.
export { isoWeekday };
