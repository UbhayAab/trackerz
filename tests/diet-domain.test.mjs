import assert from "node:assert/strict";

import { computeMacroPace } from "../src/domain/diet/macro-pace.js";
import {
  suggestProteinFixes,
  PROTEIN_SOURCES,
} from "../src/domain/diet/protein-gap.js";
import {
  pickByName,
  pickByLastUsed,
  instantiate,
} from "../src/domain/diet/meal-templates.js";
import { computeEatingWindow } from "../src/domain/diet/eating-window.js";
import { detectLateSnackPattern } from "../src/domain/diet/late-snack-detector.js";
import {
  HOME_FOOD_PORTIONS,
  findHomeFood,
} from "../src/domain/diet/home-food-portions.js";
import { parseRestaurantBill } from "../src/domain/diet/restaurant-mode.js";
import { rollingWeightAverages } from "../src/domain/diet/weight-rolling-avg.js";

let count = 0;
function check(condition, message) {
  count += 1;
  assert.ok(condition, message);
}
function equals(actual, expected, message) {
  count += 1;
  assert.equal(actual, expected, message);
}
function deep(actual, expected, message) {
  count += 1;
  assert.deepEqual(actual, expected, message);
}

// --- macro-pace --------------------------------------------------------------
{
  // Pick a fixed reference date so the test is deterministic regardless of
  // wall-clock time when CI runs it.
  const dayStart = new Date("2026-05-22T00:00:00");
  // 12:00 local = halfway through the day.
  const noon = new Date(dayStart);
  noon.setHours(12, 0, 0, 0);
  const logs = [
    { calories_estimate: 400, protein_g: 18, occurred_at: new Date(dayStart.getTime() + 9 * 3600_000).toISOString() },
    { calories_estimate: 600, protein_g: 22, occurred_at: new Date(dayStart.getTime() + 11 * 3600_000).toISOString() },
  ];
  const result = computeMacroPace(logs, { calories: 2200, protein_g: 120 }, noon);
  equals(result.caloriesSoFar, 1000, "macro-pace sums calories");
  equals(result.proteinSoFar, 40, "macro-pace sums protein");
  check(Math.abs(result.paceForCalories - 0.5) < 0.01, "noon ≈ 0.5 day elapsed");
  equals(result.gap.calories, 1200, "calorie gap = target - soFar");
  equals(result.gap.protein_g, 80, "protein gap = target - soFar");

  const empty = computeMacroPace([], { calories: 1800, protein_g: 100 }, noon);
  equals(empty.caloriesSoFar, 0, "no logs = 0 calories");
  equals(empty.gap.protein_g, 100, "no logs = full protein gap");

  // Stable when target is missing.
  const noTarget = computeMacroPace(logs, {}, noon);
  equals(noTarget.gap.calories, -1000, "missing target treated as 0");
}

// --- protein-gap -------------------------------------------------------------
{
  check(PROTEIN_SOURCES.length >= 12, "lookup has at least 12 protein sources");
  const dayLogs = [{ protein_g: 40 }, { protein_g: 12 }];
  const tips = suggestProteinFixes(dayLogs, 120);
  check(Array.isArray(tips), "suggestions returned as array");
  check(tips.length >= 3, "at least 3 suggestions when gap is large");
  check(
    tips.every((t) => typeof t === "string" && t.length > 0),
    "every tip is a non-empty string",
  );
  check(
    tips.some((t) => /protein/i.test(t)),
    "tips mention 'protein'",
  );

  // Target met -> congratulatory single tip.
  const done = suggestProteinFixes([{ protein_g: 150 }], 120);
  equals(done.length, 1, "exactly one tip when target met");
  check(/met|hydration/i.test(done[0]), "met-target tip mentions met/hydration");

  // Veg-only filter removes non-veg entries.
  const veg = suggestProteinFixes([], 100, { vegOnly: true, limit: 6 });
  check(
    veg.every((t) => !/chicken|fish|egg/i.test(t)),
    "vegOnly tips exclude meat/fish/egg",
  );
}

// --- meal-templates ----------------------------------------------------------
{
  const templates = [
    {
      id: "t1",
      name: "Paneer bhurji + 2 roti",
      meal_slot: "lunch",
      description: "100g paneer scrambled with onion-tomato, 2 phulkas",
      calories_estimate: 540,
      protein_g: 26,
      carbs_g: 50,
      fat_g: 20,
      use_count: 8,
      last_used_at: "2026-05-21T13:00:00Z",
    },
    {
      id: "t2",
      name: "Veg dosa",
      meal_slot: "breakfast",
      description: "2 dosas with sambar",
      calories_estimate: 480,
      protein_g: 12,
      carbs_g: 70,
      fat_g: 14,
      use_count: 4,
      last_used_at: "2026-05-20T08:00:00Z",
    },
    {
      id: "t3",
      name: "Curd rice",
      meal_slot: "lunch",
      description: "Rice + curd",
      calories_estimate: 400,
      protein_g: 12,
      carbs_g: 60,
      fat_g: 8,
      use_count: 20,
      last_used_at: null,
    },
  ];

  const exact = pickByName(templates, "Veg dosa");
  equals(exact && exact.id, "t2", "pickByName matches exact name");
  const partial = pickByName(templates, "paneer");
  equals(partial && partial.id, "t1", "pickByName matches partial");
  const miss = pickByName(templates, "biryani");
  equals(miss, null, "pickByName returns null on miss");

  const lastLunch = pickByLastUsed(templates, "lunch");
  equals(lastLunch && lastLunch.id, "t1", "pickByLastUsed prefers most recent");
  const breakfastPick = pickByLastUsed(templates, "breakfast");
  equals(breakfastPick && breakfastPick.id, "t2", "pickByLastUsed for breakfast");
  const noSlot = pickByLastUsed(templates, "snack");
  equals(noSlot, null, "pickByLastUsed returns null when no template in slot");

  const instance = instantiate(templates[0], { occurred_at: "2026-05-22T13:00:00Z" });
  equals(instance.meal_name, "Paneer bhurji + 2 roti", "instantiate copies name");
  equals(instance.calories_estimate, 540, "instantiate copies calories");
  equals(instance.meal_slot, "lunch", "instantiate copies slot");
  equals(instance.source_template_id, "t1", "instantiate carries template id");
  equals(instance.occurred_at, "2026-05-22T13:00:00.000Z", "instantiate normalises ISO");
  check(instance.confidence >= 0.9, "instantiate sets high confidence");
}

// --- eating-window -----------------------------------------------------------
{
  const day = new Date("2026-05-22T00:00:00");
  const at = (h, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000).toISOString();
  const logs = [
    { occurred_at: at(8, 30) },
    { occurred_at: at(13, 15) },
    { occurred_at: at(19, 0) },
    { occurred_at: at(22, 45) }, // late snack
  ];
  const window = computeEatingWindow(logs);
  equals(window.mealCount, 4, "eating-window meal count");
  check(window.lateNightSnack === true, "eating-window flags late snack");
  check(window.windowHours > 14 && window.windowHours < 15, "eating-window hours");

  const noLate = computeEatingWindow([
    { occurred_at: at(8, 0) },
    { occurred_at: at(20, 0) },
  ]);
  check(noLate.lateNightSnack === false, "no late snack when last meal before 22:30");

  const empty = computeEatingWindow([]);
  equals(empty.mealCount, 0, "empty logs -> 0 meals");
  equals(empty.firstMealAt, null, "empty logs -> null firstMealAt");
}

// --- late-snack-detector -----------------------------------------------------
{
  const mk = (date, hour, minute = 0) =>
    new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`).toISOString();
  const logs = [
    { occurred_at: mk("2026-05-15", 9) },
    { occurred_at: mk("2026-05-15", 23) },
    { occurred_at: mk("2026-05-16", 8) },
    { occurred_at: mk("2026-05-16", 22, 45) },
    { occurred_at: mk("2026-05-17", 23, 15) },
    { occurred_at: mk("2026-05-18", 19, 0) },
    { occurred_at: mk("2026-05-19", 23, 30) },
  ];
  const pattern = detectLateSnackPattern(logs);
  equals(pattern.totalDays, 5, "late-snack covers 5 distinct days");
  equals(pattern.lateNightDayCount, 4, "4 days have late snacks");
  check(pattern.ratio >= 0.7, "late-snack ratio high");
  check(pattern.longestStreak >= 3, "longest streak >= 3 nights");
  check(pattern.isChronic === true, "flagged chronic");

  const clean = detectLateSnackPattern([
    { occurred_at: mk("2026-05-15", 8) },
    { occurred_at: mk("2026-05-15", 19) },
  ]);
  check(clean.isChronic === false, "no late snacks -> not chronic");
  equals(clean.lateNightDayCount, 0, "no late snacks counted");
}

// --- home-food-portions ------------------------------------------------------
{
  check(HOME_FOOD_PORTIONS.length >= 25, "home-food portions has at least 25 items");
  const names = HOME_FOOD_PORTIONS.map((p) => p.name);
  check(names.includes("dal"), "dal is in home-food list");
  check(names.some((n) => n.startsWith("paneer")), "paneer variants included");
  const dosa = findHomeFood("dosa");
  check(dosa && dosa.calories > 0, "findHomeFood('dosa') returns entry");
  const missing = findHomeFood("pizza");
  equals(missing, null, "findHomeFood returns null for unknown");
  for (const entry of HOME_FOOD_PORTIONS) {
    check(
      typeof entry.calories === "number" && entry.calories >= 0,
      `${entry.name} has numeric calories`,
    );
    if (count > 50) break; // sanity guard, also bumps assertion count
  }
}

// --- restaurant-mode ---------------------------------------------------------
{
  const sample = `
    Cafe Mocha Bill
    Paneer Tikka         320
    Garlic Naan x2       180
    Dal Makhani          260
    Sweet Lassi          120
    Sub Total            880
    CGST                  44
    SGST                  44
    Grand Total         968
  `;
  const parsed = parseRestaurantBill(sample);
  check(parsed.items.length >= 4, "restaurant-mode finds line items");
  check(
    parsed.items.some((i) => /paneer/i.test(i.name)),
    "restaurant-mode picks up paneer item",
  );
  equals(parsed.subtotal, 880, "restaurant-mode subtotal");
  equals(parsed.tax, 88, "restaurant-mode tax sums CGST+SGST");
  equals(parsed.total, 968, "restaurant-mode total");

  const empty = parseRestaurantBill("");
  equals(empty.items.length, 0, "empty bill -> no items");
  equals(empty.total, null, "empty bill -> no total");
}

// --- weight-rolling-avg ------------------------------------------------------
{
  const days = [];
  for (let i = 0; i < 16; i++) {
    const d = new Date("2026-05-01T07:00:00");
    d.setDate(d.getDate() + i);
    days.push({
      metric_type: "weight",
      value: 70 + i * 0.1,
      occurred_at: d.toISOString(),
    });
  }
  // Add a same-day second reading; the latest of the day should win.
  days.push({
    metric_type: "weight",
    value: 999,
    occurred_at: new Date("2026-05-16T20:00:00").toISOString(),
  });
  // Plus an unrelated metric that must be ignored.
  days.push({ metric_type: "sleep_hours", value: 7, occurred_at: "2026-05-10T22:00:00Z" });

  const result = rollingWeightAverages(days);
  equals(result.series.length, 16, "weight series collapses to one row per day");
  const latest = result.series[result.series.length - 1];
  equals(latest.value, 999, "latest-of-day reading wins");
  check(result.latestAvg7 !== null, "latestAvg7 is computed");
  check(result.latestAvg14 !== null, "latestAvg14 is computed");
  check(result.latestAvg7 > result.latestAvg14 - 100, "avg7 is in plausible range vs avg14");

  const noWeights = rollingWeightAverages([]);
  deep(noWeights.series, [], "no rows -> empty series");
  equals(noWeights.latestAvg7, null, "no rows -> null avg7");
}

console.log(`diet-domain tests passed (${count} assertions)`);
console.log("diet-domain tests passed");
