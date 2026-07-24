import assert from "node:assert/strict";
import { buildInsights } from "../lib/analytics-insights.mjs";

let n = 0;
function ok(c, msg) { assert.ok(c, msg); n += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); n += 1; }

// Anchor: 2026-07-23 12:00 IST. Build IST timestamps by appending +05:30.
const today = new Date("2026-07-23T12:00:00+05:30");
const ist = (dateKey, hhmm = "12:00") => `${dateKey}T${hhmm}:00+05:30`;
const byId = (arr, id) => arr.find((x) => x.id === id);

// ---- Empty state: no data at all -> [] with a reason -----------------------
{
  const r = buildInsights({ today });
  ok(r.empty === true, "empty when no data");
  eq(r.insights.length, 0, "no insights when no data");
  ok(typeof r.reason === "string" && r.reason.length, "empty state carries a reason");
}

// ---- Protein short: 4 logged days averaging well under target --------------
{
  const foodLogs = [];
  for (let i = 0; i < 4; i++) {
    const k = `2026-07-${String(20 + i).padStart(2, "0")}`;
    foodLogs.push({ meal_name: "eggs + roti", meal_slot: "lunch", protein_g: 40, calories_estimate: 500, occurred_at: ist(k, "13:00") });
    foodLogs.push({ meal_name: "Whey shake", meal_slot: "snack", protein_g: 56, calories_estimate: 160, occurred_at: ist(k, "18:00") });
  }
  const { insights } = buildInsights({ foodLogs, budgets: [{ kind: "daily_protein", amount: 151 }], today });
  const p = byId(insights, "protein-short");
  ok(p, "protein-short fires when short of target");
  eq(p.metric.avg, 96, "avg = 40+56 per day");
  eq(p.metric.target, 151);
  eq(p.metric.loggedDays, 4);
  ok(p.detail.includes("Whey shake"), "cites best protein source");
  ok(p.evidence.includes("4 days"), "evidence names logged-day count");
}

// ---- Protein no-data prompt (foodLogs exist but not in this week) ----------
{
  const foodLogs = [{ meal_name: "old meal", meal_slot: "lunch", protein_g: 30, occurred_at: ist("2026-06-01") }];
  const { insights } = buildInsights({ foodLogs, budgets: [{ kind: "daily_protein", amount: 151 }], today });
  const p = byId(insights, "protein-nodata");
  ok(p, "prompts to log when no meals this week");
  eq(p.metric.loggedDays, 0);
}

// ---- THE RULE: never fabricate a metric with zero support ------------------
{
  // Only a single ledger row: gym / protein / weight insights must NOT appear.
  const { insights } = buildInsights({ ledger: [{ direction: "expense", amount: 110, merchant: "lunch", occurred_at: ist("2026-07-23") }], today });
  ok(!byId(insights, "gym-frequency"), "no gym insight without workout rows");
  ok(!insights.some((i) => i.domain === "diet"), "no diet insight without food rows");
  ok(!byId(insights, "weight-trend"), "no weight trend without weight rows");
}

// ---- Gym: distinct done days this week + 14d, planned from budget ----------
{
  const workoutLogs = [
    { status: "done", occurred_at: ist("2026-07-21", "07:00") },
    { status: "done", occurred_at: ist("2026-07-21", "19:00") }, // same day, counts once
    { status: "done", occurred_at: ist("2026-07-23", "07:00") },
    { status: "skipped", occurred_at: ist("2026-07-22", "07:00") },
    { status: "done", occurred_at: ist("2026-07-12", "07:00") }, // within 14d, not 7d
  ];
  const { insights } = buildInsights({ workoutLogs, budgets: [{ kind: "weekly_workouts", amount: 4 }], today });
  const g = byId(insights, "gym-frequency");
  ok(g, "gym insight fires with workout rows");
  eq(g.metric.thisWeek, 2, "2 distinct done days this week");
  eq(g.metric.lastTwoWeeks, 3, "3 distinct done days in 14d");
  eq(g.metric.planned, 4);
  ok(g.headline.includes("2 of 4"), "headline shows done-of-planned");
}

// ---- Money: biggest recurring spend ----------------------------------------
{
  const ledger = [];
  for (let i = 0; i < 4; i++) ledger.push({ direction: "expense", amount: 110, merchant: "lunch", occurred_at: ist(`2026-07-${20 + i}`) });
  ledger.push({ direction: "expense", amount: 1103, merchant: "fuel", occurred_at: ist("2026-07-22") });
  const { insights } = buildInsights({ ledger, today });
  const rec = byId(insights, "recurring-spend");
  ok(rec, "recurring spend fires at count>=3");
  eq(rec.metric.count, 4);
  eq(rec.metric.total, 440);
  ok(rec.headline.includes("Rs 440"), "headline shows weekly total");
}

// ---- Money: month pace vs cap (over cap -> warn/critical) -------------------
{
  // 5 days x Rs 500 = 2500 by day 23 -> perDay ~108.7 -> projected ~3370 for 31d,
  // under a 45000 cap => good. Build an over-cap case instead.
  const ledger = [];
  for (let d = 1; d <= 23; d++) ledger.push({ direction: "expense", amount: 2000, occurred_at: ist(`2026-07-${String(d).padStart(2, "0")}`) });
  const { insights } = buildInsights({ ledger, budgets: [{ kind: "monthly_spend", amount: 45000 }], today });
  const mp = byId(insights, "month-pace");
  ok(mp, "month pace fires when a monthly_spend cap exists");
  ok(mp.metric.projected > mp.metric.cap, "projects over cap");
  ok(mp.severity === "warn" || mp.severity === "critical", "over-cap is warn/critical");
}

// No monthly cap -> no month-pace insight (no fabricated cap).
{
  const ledger = [{ direction: "expense", amount: 2000, occurred_at: ist("2026-07-10") }];
  const { insights } = buildInsights({ ledger, today });
  ok(!byId(insights, "month-pace"), "no month pace without a cap budget");
}

// ---- Meal-slot gap: breakfast most days, dinner rarely ---------------------
{
  const foodLogs = [];
  for (let i = 0; i < 8; i++) {
    const k = `2026-07-${String(16 + i).padStart(2, "0")}`;
    foodLogs.push({ meal_slot: "breakfast", protein_g: 10, calories_estimate: 300, occurred_at: ist(k, "08:00") });
    if (i < 2) foodLogs.push({ meal_slot: "dinner", protein_g: 20, calories_estimate: 600, occurred_at: ist(k, "21:00") });
  }
  const { insights } = buildInsights({ foodLogs, today });
  const gap = byId(insights, "meal-gap-dinner");
  ok(gap, "meal gap fires when dinner logging lags breakfast");
  ok(gap.metric.dinnerDays < gap.metric.breakfastDays);
}

// ---- Weight trend: needs >= 2 readings --------------------------------------
{
  const one = buildInsights({ bodyMetrics: [{ metric_type: "weight", value: 74, occurred_at: ist("2026-07-20") }], today });
  ok(!byId(one.insights, "weight-trend"), "single weight reading is not a trend");
  const two = buildInsights({ bodyMetrics: [
    { metric_type: "weight", value: 75, occurred_at: ist("2026-07-05") },
    { metric_type: "weight", value: 73.5, occurred_at: ist("2026-07-22") },
  ], today });
  const w = byId(two.insights, "weight-trend");
  ok(w, "weight trend fires with 2+ readings");
  eq(w.metric.change, -1.5);
}

// ---- Ranking: critical/warn sort ahead of info -----------------------------
{
  const ledger = [];
  for (let d = 1; d <= 23; d++) ledger.push({ direction: "expense", amount: 3000, occurred_at: ist(`2026-07-${String(d).padStart(2, "0")}`) });
  for (let i = 0; i < 4; i++) ledger.push({ direction: "expense", amount: 110, merchant: "lunch", occurred_at: ist(`2026-07-${20 + i}`) });
  const { insights } = buildInsights({ ledger, budgets: [{ kind: "monthly_spend", amount: 45000 }], today });
  const weights = { critical: 3, warn: 2, good: 1, info: 0 };
  for (let i = 1; i < insights.length; i++) {
    ok(weights[insights[i - 1].severity] >= weights[insights[i].severity], "sorted by severity desc");
  }
}

console.log(`analytics-insights tests passed: ${n} assertions`);
