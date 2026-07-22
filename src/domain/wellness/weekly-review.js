// Composes a weekly review payload suitable for storing in `weekly_reviews.summary`.
// Pure - no IO. Inputs match the supabase row shapes.

import { computeHabitScore } from "./habit-score.js";
import { computeSleepDebt } from "./sleep-debt.js";
import { computeStepSummary } from "./step-summary.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function inWeek(value, startMs, endMs) {
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && t >= startMs && t < endMs;
}

function inr(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
}

export function composeWeeklyReview({
  weekStart,
  ledger = [],
  foodLogs = [],
  wellnessLogs = [],
  bodyMetrics = [],
} = {}) {
  const start = new Date(weekStart);
  start.setUTCHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const endMs = startMs + 7 * DAY_MS;
  const todayISO = new Date(endMs - DAY_MS).toISOString();

  // --- Money
  const weekLedger = ledger.filter((l) => inWeek(l.occurred_at, startMs, endMs));
  const expenses = weekLedger.filter((l) => l.direction === "expense");
  const income = weekLedger.filter((l) => l.direction === "income");
  const totalSpent = expenses.reduce((a, l) => a + Math.abs(Number(l.amount || 0)), 0);
  const totalIncome = income.reduce((a, l) => a + Math.abs(Number(l.amount || 0)), 0);
  const byMerchant = new Map();
  for (const l of expenses) {
    const key = l.merchant || l.description || "uncategorised";
    byMerchant.set(key, (byMerchant.get(key) || 0) + Math.abs(Number(l.amount || 0)));
  }
  const topMerchant = [...byMerchant.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  const moneyHighlights = [
    `Spent ${inr(totalSpent)} across ${expenses.length} entries`,
    `Income recorded: ${inr(totalIncome)}`,
    topMerchant ? `Top merchant: ${topMerchant[0]} (${inr(topMerchant[1])})` : "No standout merchant",
  ];

  // --- Diet
  const weekFoods = foodLogs.filter((f) => inWeek(f.occurred_at, startMs, endMs));
  const totalCalories = weekFoods.reduce((a, f) => a + Number(f.calories_estimate || 0), 0);
  const totalProtein = weekFoods.reduce((a, f) => a + Number(f.protein_g || 0), 0);
  const proteinDays = new Set(
    weekFoods.filter((f) => Number(f.protein_g || 0) > 0).map((f) => f.occurred_at.slice(0, 10)),
  ).size;
  const dietHighlights = [
    `${weekFoods.length} meals logged (${Math.round(totalCalories)} kcal total)`,
    `Average protein: ${Math.round(totalProtein / 7)}g/day`,
    `Logged protein on ${proteinDays}/7 days`,
  ];

  // --- Wellness
  const sleep = computeSleepDebt(
    bodyMetrics.filter((m) => inWeek(m.occurred_at, startMs, endMs)),
  );
  const steps = computeStepSummary(
    bodyMetrics.filter((m) => inWeek(m.occurred_at, startMs, endMs)),
  );
  const moods = wellnessLogs
    .filter((w) => inWeek(w.occurred_at, startMs, endMs) && w.mood_score != null)
    .map((w) => Number(w.mood_score));
  const avgMood = moods.length
    ? Number((moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(2))
    : null;
  const wellnessHighlights = [
    `Avg sleep ${sleep.dailyAvg}h (debt ${sleep.debtHours}h)`,
    `Avg steps ${steps.avg} (hit target on ${steps.hitDays}/7 days)`,
    avgMood != null ? `Avg mood ${avgMood}/10 over ${moods.length} entries` : "No mood data logged",
  ];

  // --- Habit score over the week
  const { score } = computeHabitScore({
    wellnessLogs,
    bodyMetrics,
    foodLogs,
    ledger,
    todayISO,
  });

  const net = totalIncome - totalSpent;
  const oneLiner =
    `Week of ${start.toISOString().slice(0, 10)}: habit ${score}/100, ` +
    `${moneyDirection(net)} ${inr(Math.abs(net))}, ` +
    `avg sleep ${sleep.dailyAvg}h, avg steps ${steps.avg}.`;

  return {
    moneyHighlights,
    dietHighlights,
    wellnessHighlights,
    score,
    oneLiner,
  };
}

function moneyDirection(net) {
  if (net > 0) return "saved";
  if (net < 0) return "overspent";
  return "broke even at";
}
