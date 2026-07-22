// Generates short, opinionated one-liners from the period aggregator output.
// No AI calls - pure rules. The agent can ADD richer insights later, but the
// app should never feel empty.

import { computeBudgetAlerts } from "../domain/money/budget-alerts.js";

function fmtRupees(n) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function pct(n) {
  return `${Math.round(n * 100)}%`;
}

export function composeInsights({ aggregates, budgets = [], subscriptions = [], ledger = [], today = new Date() } = {}) {
  const out = [];
  const { today: t, yesterday, week, prev_week: pw, month, prev_month: pm, deltas } = aggregates || {};
  if (!t) return out;

  // Today
  out.push({ kind: "money", severity: "info", text: `Today: ${fmtRupees(t.spend)} spent across ${t.mealCount ? `${t.mealCount} meals` : "no meals logged"}.` });
  if (deltas?.dod_spend > 0.5 && yesterday?.spend > 0) {
    out.push({ kind: "money", severity: "warning", text: `Spend ${pct(deltas.dod_spend)} higher than yesterday.` });
  }

  // Week
  if (week && pw) {
    if (deltas?.wow_spend > 0.25) out.push({ kind: "money", severity: "warning", text: `Week-over-week spend up ${pct(deltas.wow_spend)} (${fmtRupees(week.spend)} vs ${fmtRupees(pw.spend)}).` });
    else if (deltas?.wow_spend < -0.15) out.push({ kind: "money", severity: "good", text: `Week-over-week spend down ${pct(-deltas.wow_spend)}.` });
  }

  // Month - skip the meaningless zero-vs-zero case for brand-new users.
  if (month && pm && deltas?.mom_spend !== undefined && (month.spend > 0 || pm.spend > 0)) {
    out.push({ kind: "money", severity: deltas.mom_spend > 0.1 ? "warning" : "info", text: `MoM spend ${deltas.mom_spend >= 0 ? "up" : "down"} ${pct(Math.abs(deltas.mom_spend))} (${fmtRupees(month.spend)} vs ${fmtRupees(pm.spend)}).` });
  }

  // Diet
  if (t.protein < 90 && t.mealCount >= 2) {
    out.push({ kind: "diet", severity: "warning", text: `Protein at ${t.protein}g - gap to 162g target.` });
  }
  if (deltas?.dod_calories > 0.25 && yesterday?.calories > 0) {
    out.push({ kind: "diet", severity: "info", text: `Calorie pace higher than yesterday.` });
  }

  // Subscriptions
  for (const sub of subscriptions.slice(0, 3)) {
    const days = sub.next_expected_at ? Math.round((new Date(sub.next_expected_at).getTime() - today.getTime()) / 86_400_000) : null;
    if (days !== null && days <= 5 && days >= 0) {
      out.push({ kind: "money", severity: "info", text: `${sub.merchant}: next charge in ${days}d (${fmtRupees(sub.median_amount)}).` });
    }
  }

  // Budgets
  const alerts = computeBudgetAlerts({ ledger, budgets, today });
  for (const a of alerts.slice(0, 4)) {
    out.push({ kind: "money", severity: a.severity === "exceeded" ? "critical" : "warning", text: a.message });
  }

  return out;
}
