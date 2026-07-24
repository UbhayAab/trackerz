// Diet intelligence + coaching engine (PURE, no DOM / no Supabase).
//
// Turns real food_logs into evidence-based coaching: protein gap vs the user's
// own target, the user's OWN best protein sources ranked from what he actually
// logs, a concrete "add X" fix drawn from those foods, calorie pace + week
// trend, macro balance, and which meal slots he logs vs skips.
//
// THE UNBREAKABLE RULE lives here: a day with no food logged is NEVER counted
// as "0 protein" and narrated as fact. Unlogged days are marked hasData:false,
// averages are taken over LOGGED days only (with the count exposed), and when
// there are fewer than 3 logged days we return thin:true so the UI says "log a
// few more days" instead of asserting a trend. Every number carries the count
// of days it was derived from.

import { jbDateKeyInTz, jbAddDays } from "./jarvis-brief.mjs";

const KOLKATA = "Asia/Kolkata";
const MEAL_SLOTS = ["breakfast", "lunch", "snack", "dinner"];
const THIN_DAYS = 3; // below this many logged days we do not assert a trend
const CARB_HEAVY_PCT = 55; // carbs above this share of calories = carb-heavy

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round(num(n) * f) / f;
}

function normName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Build the last `days` civil date keys (oldest first) ending on `now`'s day.
function lastDayKeys(now, days, tz) {
  const todayKey = jbDateKeyInTz(now, tz);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(jbAddDays(todayKey, -i));
  return keys;
}

// Sum a day's logs into a macro bucket.
function emptyDay() {
  return { protein: 0, calories: 0, carbs: 0, fat: 0, count: 0 };
}

// Group food logs by civil date key (tz-aware). Rows without occurred_at are
// dropped from the daily view (they can't be placed on a day) but that is a
// silent, safe omission - they simply don't contribute to a specific day.
function groupByDay(foodLogs, tz) {
  const byDay = new Map();
  for (const row of foodLogs || []) {
    if (!row || !row.occurred_at) continue;
    const at = new Date(row.occurred_at);
    if (Number.isNaN(at.getTime())) continue;
    const key = jbDateKeyInTz(at, tz);
    if (!byDay.has(key)) byDay.set(key, emptyDay());
    const d = byDay.get(key);
    d.protein += num(row.protein_g);
    d.calories += num(row.calories_estimate);
    d.carbs += num(row.carbs_g);
    d.fat += num(row.fat_g);
    d.count += 1;
  }
  return byDay;
}

// Average of the values, or null when there is nothing to average - so callers
// render "-" rather than a fabricated 0.
function avgOrNull(values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

// Rank the user's OWN logged foods by total protein contribution across the
// window. Returns [{ name, totalProtein, perItemProtein, count, totalCalories }].
function rankBestSources(rowsInWindow) {
  const byName = new Map();
  for (const row of rowsInWindow) {
    const name = normName(row.meal_name || row.description);
    if (!name) continue;
    const p = num(row.protein_g);
    if (!byName.has(name)) {
      byName.set(name, { name, totalProtein: 0, count: 0, totalCalories: 0, display: row.meal_name || row.description });
    }
    const e = byName.get(name);
    e.totalProtein += p;
    e.totalCalories += num(row.calories_estimate);
    e.count += 1;
  }
  return [...byName.values()]
    .map((e) => ({
      name: e.display,
      totalProtein: round(e.totalProtein, 1),
      perItemProtein: round(e.totalProtein / e.count, 1),
      count: e.count,
      totalCalories: round(e.totalCalories),
    }))
    .filter((e) => e.totalProtein > 0)
    .sort((a, b) => b.totalProtein - a.totalProtein);
}

// Concrete "add X" fix drawn from the user's OWN highest-per-serving protein
// food. Returns null when the gap is met or he has logged no protein foods yet
// (in which case the UI asks him to log first, rather than inventing advice).
function buildSuggestion(gap, bestSources) {
  if (gap == null || gap <= 0) return null;
  if (!bestSources.length) return null;
  // Pick the most protein-dense of HIS foods to close the gap efficiently.
  const best = [...bestSources].sort((a, b) => b.perItemProtein - a.perItemProtein)[0];
  if (!best || best.perItemProtein <= 0) return null;
  const servings = Math.max(1, Math.ceil(gap / best.perItemProtein));
  const added = round(servings * best.perItemProtein, 0);
  const noun = servings === 1 ? "serving" : "servings";
  return {
    food: best.name,
    servings,
    perItemProtein: best.perItemProtein,
    addedProtein: added,
    text: `Add ${servings} more ${noun} of your ${best.name} (~${best.perItemProtein}g each) to add about ${added}g protein and close the gap.`,
  };
}

// Macro split by calorie share over the window's logged days.
function macroSplit(totals) {
  const pCal = totals.protein * 4;
  const cCal = totals.carbs * 4;
  const fCal = totals.fat * 9;
  const denom = pCal + cCal + fCal;
  if (denom <= 0) return null; // no macro grams logged - do not invent a split
  return {
    proteinPct: round((pCal / denom) * 100),
    carbPct: round((cCal / denom) * 100),
    fatPct: round((fCal / denom) * 100),
    carbHeavy: (cCal / denom) * 100 > CARB_HEAVY_PCT,
    proteinG: round(totals.protein),
    carbsG: round(totals.carbs),
    fatG: round(totals.fat),
  };
}

// Direction of the calorie trend across logged days: compare the mean of the
// earlier half to the later half. Only meaningful with >= THIN_DAYS logged days.
function calorieTrend(loggedDayCalories) {
  if (loggedDayCalories.length < THIN_DAYS) return null;
  const mid = Math.floor(loggedDayCalories.length / 2);
  const earlier = loggedDayCalories.slice(0, mid);
  const later = loggedDayCalories.slice(loggedDayCalories.length - mid);
  const a = avgOrNull(earlier);
  const b = avgOrNull(later);
  if (a == null || b == null) return null;
  const delta = b - a;
  if (Math.abs(delta) < 100) return "flat";
  return delta > 0 ? "up" : "down";
}

/**
 * @param {Array} foodLogs  state.foodLogs rows
 * @param {{protein_g:number, calories:number}} targets  resolved diet targets
 * @param {{now?:Date|string, tz?:string, windowDays?:number}} [options]
 */
export function computeDietInsights(foodLogs, targets, options = {}) {
  const tz = options.tz || KOLKATA;
  const now = options.now ? new Date(options.now) : new Date();
  const windowDays = options.windowDays || 7;

  const proteinTarget = num(targets?.protein_g);
  const calorieTarget = num(targets?.calories);

  const byDay = groupByDay(foodLogs, tz);
  const keys = lastDayKeys(now, windowDays, tz);
  const todayKey = keys[keys.length - 1];

  // Per-day series across the window; unlogged days are hasData:false (NOT 0).
  const series = keys.map((key) => {
    const d = byDay.get(key);
    return {
      dateKey: key,
      hasData: !!(d && d.count > 0),
      protein: d ? round(d.protein, 1) : null,
      calories: d ? round(d.calories) : null,
      isToday: key === todayKey,
    };
  });

  const loggedDays = series.filter((s) => s.hasData);
  const daysWithData = loggedDays.length;
  const thin = daysWithData < THIN_DAYS;

  // Today's values: null when nothing logged today (render "-", never 0).
  const todayEntry = series[series.length - 1];
  const proteinToday = todayEntry.hasData ? todayEntry.protein : null;
  const caloriesToday = todayEntry.hasData ? todayEntry.calories : null;

  // Averages over LOGGED days only.
  const proteinAvg = avgOrNull(loggedDays.map((s) => s.protein));
  const calorieAvg = avgOrNull(loggedDays.map((s) => s.calories));

  const rowsInWindow = (foodLogs || []).filter((r) => {
    if (!r || !r.occurred_at) return false;
    const at = new Date(r.occurred_at);
    if (Number.isNaN(at.getTime())) return false;
    const key = jbDateKeyInTz(at, tz);
    return keys.includes(key);
  });

  const bestSources = rankBestSources(rowsInWindow);

  // Protein gaps. Positive gap = shortfall (target - actual).
  const todayGap = proteinToday == null ? null : round(proteinTarget - proteinToday, 1);
  const avgGap = proteinAvg == null ? null : round(proteinTarget - proteinAvg, 1);
  // "Consistently short" only if we have enough logged days AND every logged
  // day fell short - an evidence-based claim, not a guess.
  const consistentlyShort = !thin && loggedDays.every((s) => s.protein < proteinTarget);

  // Suggestion closes today's gap if we have today's data, else the average gap.
  const gapForFix = todayGap != null ? todayGap : avgGap;
  const suggestion = buildSuggestion(gapForFix, bestSources);

  // Macro totals across logged days in the window.
  const totals = loggedDays.reduce(
    (acc, s) => {
      const d = byDay.get(s.dateKey);
      acc.protein += d.protein;
      acc.carbs += d.carbs;
      acc.fat += d.fat;
      return acc;
    },
    { protein: 0, carbs: 0, fat: 0 },
  );
  const split = macroSplit(totals);

  // Meal-slot logging coverage across the window.
  const slotCounts = Object.fromEntries(MEAL_SLOTS.map((s) => [s, 0]));
  let otherCount = 0;
  for (const r of rowsInWindow) {
    const slot = normName(r.meal_slot);
    if (slot in slotCounts) slotCounts[slot] += 1;
    else otherCount += 1;
  }
  const neverLogged = MEAL_SLOTS.filter((s) => slotCounts[s] === 0);

  return {
    tz,
    windowDays,
    todayKey,
    daysWithData,
    thin,
    target: { protein_g: proteinTarget, calories: calorieTarget },
    protein: {
      today: proteinToday,
      avg: proteinAvg == null ? null : round(proteinAvg, 1),
      target: proteinTarget,
      todayGap,
      avgGap,
      consistentlyShort,
    },
    calories: {
      today: caloriesToday,
      avg: calorieAvg == null ? null : round(calorieAvg),
      target: calorieTarget,
      // Positive delta = over target, negative = under.
      todayDelta: caloriesToday == null ? null : round(caloriesToday - calorieTarget),
      avgDelta: calorieAvg == null ? null : round(calorieAvg - calorieTarget),
      trend: calorieTrend(loggedDays.map((s) => s.calories)),
    },
    macro: split,
    bestSources,
    suggestion,
    mealSlots: { counts: slotCounts, other: otherCount, neverLogged },
    proteinSeries: series.map((s) => ({
      dateKey: s.dateKey,
      hasData: s.hasData,
      protein: s.protein,
      isToday: s.isToday,
    })),
  };
}

export default computeDietInsights;
