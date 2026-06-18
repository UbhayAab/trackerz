// Fans out across every domain detector and composes one ranked insight feed.
// Pure: takes the user's recent rows, returns { items, lines }. `lines` are
// plain strings for the existing insight list renderer; `items` carry kind +
// severity for richer surfaces. This is what finally switches on the
// previously-dead analytics brain (subscriptions, protein gap, eating window,
// weight trend, sleep debt, opportunity cost, transfers/refunds).

import { aggregatePeriods } from "./period-aggregator.js";
import { composeInsights } from "./insights-feed.js";
import { computeOpportunityCost } from "./opportunity-cost.js";
import { suggestProteinFixes } from "../domain/diet/protein-gap.js";
import { detectLateSnackPattern } from "../domain/diet/late-snack-detector.js";
import { computeEatingWindow } from "../domain/diet/eating-window.js";
import { rollingWeightAverages } from "../domain/diet/weight-rolling-avg.js";
import { computeSleepDebt } from "../domain/wellness/sleep-debt.js";
import { detectTransfers } from "../domain/money/transfer-detector.js";
import { matchRefunds } from "../domain/money/refund-matcher.js";
import { safeToSpendToday } from "./cashflow-forecast.js";

const SEVERITY_RANK = { critical: 4, warning: 3, good: 2, info: 1 };

function isSameLocalDay(iso, now) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function fmtRupees(n) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export function buildInsightFeed({
  ledger = [],
  foodLogs = [],
  wellnessLogs = [],
  bodyMetrics = [],
  budgets = [],
  subscriptions = [],
  today = new Date(),
  proteinTargetG = 130,
  sleepTargetH = 8,
} = {}) {
  const items = [];
  const push = (kind, severity, text) => {
    if (text) items.push({ kind, severity, text });
  };

  // Period deltas + budget alerts + subscription-due + basic diet (reuse).
  const aggregates = aggregatePeriods({ ledger, foodLogs, wellnessLogs, bodyMetrics, today });
  for (const it of composeInsights({ aggregates, budgets, subscriptions, ledger, today })) {
    push(it.kind, it.severity, it.text);
  }

  // Diet — protein gap with a concrete fix for today.
  const todayFoods = foodLogs.filter((r) => isSameLocalDay(r.occurred_at, today));
  const proteinToday = todayFoods.reduce((s, r) => s + (Number(r.protein_g) || 0), 0);
  const proteinGap = proteinTargetG - proteinToday;
  if (todayFoods.length >= 1 && proteinGap >= 15) {
    const [fix] = suggestProteinFixes(todayFoods, proteinTargetG, { limit: 1 });
    push("diet", "warning", `Protein gap ${Math.round(proteinGap)}g. ${fix}`);
  }

  // Diet — eating window / late snack today.
  const todayWindow = computeEatingWindow(todayFoods);
  if (todayWindow.lateNightSnack) {
    push("diet", "info", `Late-night eating today (last meal after 22:30).`);
  }
  const lateSnack = detectLateSnackPattern(foodLogs);
  if (lateSnack.isChronic) {
    push("diet", "warning", `Late snacking ${lateSnack.lateNightDayCount}/${lateSnack.totalDays} days (streak ${lateSnack.longestStreak}).`);
  }

  // Diet/Fitness — weight trend (7-day rolling avg vs 14-day).
  const weight = rollingWeightAverages(bodyMetrics);
  if (weight.latestAvg7 != null && weight.latestAvg14 != null) {
    const diff = weight.latestAvg7 - weight.latestAvg14;
    if (Math.abs(diff) >= 0.2) {
      const dir = diff < 0 ? "down" : "up";
      push("fitness", diff < 0 ? "good" : "info", `Weight trend ${dir}: 7-day avg ${weight.latestAvg7}kg vs 14-day ${weight.latestAvg14}kg.`);
    }
  }

  // Wellness — sleep debt over the last 7 days.
  const sleep = computeSleepDebt(bodyMetrics, sleepTargetH);
  if (sleep.debtHours >= 3) {
    push("wellness", sleep.debtHours >= 6 ? "warning" : "info", `Sleep debt ${sleep.debtHours}h this week (avg ${sleep.dailyAvg}h/night).`);
  }

  // Money — forward-looking "safe to spend today" from budget + pace + upcoming subs.
  const safe = safeToSpendToday({ ledger, budgets, subscriptions, today });
  if (safe.hasBudget) {
    const sev = safe.perDay <= 0 ? "critical" : safe.remaining < safe.monthlyCap * 0.1 ? "warning" : "good";
    push("money", sev, `Safe to spend today: ${fmtRupees(safe.perDay)} (${fmtRupees(safe.remaining)} left over ${safe.daysLeft}d).`);
  }

  // Money — opportunity cost of discretionary spend (motivational, not advice).
  const oc = computeOpportunityCost(ledger);
  if (oc.count >= 3 && oc.gain !== 0) {
    const verb = oc.gain > 0 ? "would be worth" : "would be";
    push("money", "info", `${fmtRupees(oc.totalSpent)} of discretionary spend ${verb} ${fmtRupees(oc.hypotheticalNow)} in Nifty 50 today (${oc.pct >= 0 ? "+" : ""}${oc.pct}%).`);
  }

  // Money — internal transfers + refunds detected (informational, no auto-edit).
  const transfers = detectTransfers(ledger);
  if (transfers.length) {
    push("money", "info", `${transfers.length} likely internal transfer${transfers.length > 1 ? "s" : ""} detected — exclude from spend?`);
  }
  const refunds = matchRefunds(ledger);
  if (refunds.length) {
    push("money", "good", `${refunds.length} refund${refunds.length > 1 ? "s" : ""} matched to earlier spend.`);
  }

  // Rank: severity desc, stable; dedupe identical text; cap.
  const seen = new Set();
  const ranked = items
    .filter((it) => {
      if (seen.has(it.text)) return false;
      seen.add(it.text);
      return true;
    })
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0))
    .slice(0, 12);

  return { items: ranked, lines: ranked.map((it) => it.text) };
}

export default buildInsightFeed;
