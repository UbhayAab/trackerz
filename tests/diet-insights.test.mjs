import assert from "node:assert/strict";

import { computeDietInsights } from "../lib/diet-insights.mjs";

let count = 0;
function check(cond, msg) {
  count += 1;
  assert.ok(cond, msg);
}
function equals(a, b, msg) {
  count += 1;
  assert.equal(a, b, msg);
}

const TZ = "Asia/Kolkata";
const TARGET = { protein_g: 151, calories: 1765 };

// A fixed "now" so every day-window is deterministic. 20:00 IST on this day.
const NOW = new Date("2026-07-23T14:30:00Z"); // = 2026-07-23 20:00 IST

// Helper: an IST timestamp for a given civil date + hour.
function ist(dateKey, hour) {
  // IST is UTC+5:30 (no DST), so subtract 5.5h to get the UTC instant.
  const h = hour - 5.5;
  const base = new Date(dateKey + "T00:00:00Z");
  return new Date(base.getTime() + h * 3600 * 1000).toISOString();
}

// --- THE UNBREAKABLE RULE: unlogged days are never counted as 0 -------------
{
  const r = computeDietInsights([], TARGET, { now: NOW, tz: TZ });
  equals(r.protein.today, null, "no logs -> today protein is null, not 0");
  equals(r.protein.avg, null, "no logs -> avg protein is null, not 0");
  equals(r.calories.today, null, "no logs -> today calories null");
  equals(r.daysWithData, 0, "no logs -> zero logged days");
  check(r.thin, "no logs -> thin (do not assert a trend)");
  equals(r.calories.trend, null, "no logs -> no calorie trend asserted");
  equals(r.suggestion, null, "no logged foods -> no fabricated suggestion");
  equals(r.macro, null, "no macro grams -> no invented split");
  equals(r.proteinSeries.length, 7, "series still spans the 7-day window");
  check(r.proteinSeries.every((d) => d.hasData === false && d.protein === null),
    "every empty day is hasData:false with null protein, not 0");
}

// --- Today's protein gap from real logs --------------------------------------
{
  const logs = [
    { meal_name: "whey shake", meal_slot: "snack", protein_g: 56, calories_estimate: 250, carbs_g: 6, fat_g: 3, occurred_at: ist("2026-07-23", 9) },
    { meal_name: "egg curry lunch", meal_slot: "lunch", protein_g: 24, calories_estimate: 520, carbs_g: 40, fat_g: 22, occurred_at: ist("2026-07-23", 13) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  equals(r.protein.today, 80, "today protein sums his real logs (56+24)");
  equals(r.protein.todayGap, 71, "today gap = 151 - 80");
  check(r.suggestion && /whey shake/i.test(r.suggestion.food),
    "suggestion is drawn from HIS most protein-dense logged food");
  // whey = 56g/serving, gap 71 -> ceil(71/56)=2 servings.
  equals(r.suggestion.servings, 2, "suggests 2 whey servings to close a 71g gap");
}

// --- Best sources ranked from the user's OWN foods ---------------------------
{
  const logs = [
    { meal_name: "whey shake", protein_g: 56, calories_estimate: 250, occurred_at: ist("2026-07-22", 9) },
    { meal_name: "egg curry", protein_g: 18, calories_estimate: 400, occurred_at: ist("2026-07-22", 13) },
    { meal_name: "egg curry", protein_g: 18, calories_estimate: 400, occurred_at: ist("2026-07-21", 13) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  check(r.bestSources.length >= 2, "ranks at least two of his foods");
  equals(r.bestSources[0].name, "whey shake", "whey (56 total) ranks first by total protein");
}
{
  const logs = [
    { meal_name: "whey shake", protein_g: 56, occurred_at: ist("2026-07-22", 9) },
    { meal_name: "egg curry", protein_g: 18, occurred_at: ist("2026-07-22", 13) },
    { meal_name: "egg curry", protein_g: 18, occurred_at: ist("2026-07-21", 13) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  equals(r.bestSources[0].name, "whey shake", "whey (56 total) outranks egg curry (36 total)");
  equals(r.bestSources[0].perItemProtein, 56, "per-item protein for whey is 56");
  equals(r.bestSources[1].perItemProtein, 18, "per-item protein for egg curry averages 18");
}

// --- Thin data guard: < 3 logged days = no trend ----------------------------
{
  const logs = [
    { meal_name: "whey", protein_g: 40, calories_estimate: 1200, carbs_g: 100, fat_g: 40, occurred_at: ist("2026-07-23", 9) },
    { meal_name: "eggs", protein_g: 30, calories_estimate: 1400, carbs_g: 120, fat_g: 50, occurred_at: ist("2026-07-22", 9) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  equals(r.daysWithData, 2, "two logged days");
  check(r.thin, "two days -> thin");
  equals(r.calories.trend, null, "thin -> no calorie trend");
  equals(r.protein.consistentlyShort, false, "thin -> won't assert consistently short");
}

// --- Consistently short only when every logged day fell short ----------------
{
  const days = ["2026-07-23", "2026-07-22", "2026-07-21", "2026-07-20"];
  const logs = days.map((d) => ({
    meal_name: "eggs + rice",
    meal_slot: "lunch",
    protein_g: 60, // always below 151
    calories_estimate: 1600,
    carbs_g: 200,
    fat_g: 40,
    occurred_at: ist(d, 13),
  }));
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  equals(r.daysWithData, 4, "four logged days");
  check(!r.thin, "four days -> not thin");
  check(r.protein.consistentlyShort, "every logged day below 151 -> consistently short");
  equals(r.protein.avg, 60, "avg protein over logged days");
  equals(r.protein.avgGap, 91, "avg gap = 151 - 60");
}

// --- Macro balance: carb-heavy flag ------------------------------------------
{
  const logs = [
    // 20g protein (80cal), 100g carbs (400cal), 10g fat (90cal) -> carbs ~70%
    { meal_name: "rice plate", protein_g: 20, carbs_g: 100, fat_g: 10, calories_estimate: 600, occurred_at: ist("2026-07-23", 13) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  check(r.macro, "macro split computed from real grams");
  check(r.macro.carbHeavy, "flags carb-heavy when carbs dominate calorie share");
  equals(r.macro.proteinPct + r.macro.carbPct + r.macro.fatPct >= 99, true, "split percentages sum to ~100");
}

// --- Meal-slot coverage ------------------------------------------------------
{
  const logs = [
    { meal_name: "lunch", meal_slot: "lunch", protein_g: 20, occurred_at: ist("2026-07-23", 13) },
    { meal_name: "dinner", meal_slot: "dinner", protein_g: 20, occurred_at: ist("2026-07-23", 20) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  check(r.mealSlots.neverLogged.includes("breakfast"), "breakfast never logged is surfaced");
  check(r.mealSlots.neverLogged.includes("snack"), "snack never logged is surfaced");
  equals(r.mealSlots.counts.lunch, 1, "lunch counted once");
}

// --- Rows without occurred_at don't crash or fabricate a day -----------------
{
  const logs = [
    { meal_name: "mystery", protein_g: 30 }, // no occurred_at
    { meal_name: "eggs", protein_g: 20, occurred_at: ist("2026-07-23", 9) },
  ];
  const r = computeDietInsights(logs, TARGET, { now: NOW, tz: TZ });
  equals(r.protein.today, 20, "only the dated row lands on today");
}

console.log(`diet-insights.test.mjs: ${count} assertions passed`);
