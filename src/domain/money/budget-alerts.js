// Computes budget alerts from current spend vs configured budgets.
// Pure function: inputs are { ledger, budgets, today }. Outputs sorted alerts.

const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };

function periodStart(period, today) {
  const d = new Date(today);
  if (period === "daily") d.setHours(0, 0, 0, 0);
  else if (period === "weekly") {
    const day = d.getDay();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
  } else if (period === "monthly") {
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
  }
  return d;
}

function expectedPaceShare(period, today) {
  if (period === "daily") return 1;
  if (period === "weekly") {
    const day = new Date(today).getDay() + 1;
    return Math.min(1, day / 7);
  }
  if (period === "monthly") {
    const d = new Date(today);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return Math.min(1, d.getDate() / last);
  }
  return 1;
}

export function computeBudgetAlerts({ ledger = [], budgets = [], today = new Date() } = {}) {
  const out = [];
  for (const budget of budgets) {
    const start = periodStart(budget.period, today);
    const items = ledger.filter((r) =>
      r.direction === "expense"
      && new Date(r.occurred_at) >= start
      && (budget.category_id ? r.category_id === budget.category_id : true)
    );
    const spent = items.reduce((acc, r) => acc + Math.abs(Number(r.amount || 0)), 0);
    const cap = Number(budget.amount || 0);
    if (!cap) continue;
    const pctSpent = spent / cap;
    const pctElapsed = expectedPaceShare(budget.period, today);
    const overPace = pctSpent > pctElapsed + 0.15;
    const severity = pctSpent >= 1 ? "exceeded"
      : pctSpent >= 0.9 ? "critical"
      : pctSpent >= 0.75 ? "warning"
      : overPace ? "pace"
      : "ok";
    if (severity === "ok") continue;
    out.push({
      budget_id: budget.id,
      category_id: budget.category_id || null,
      period: budget.period,
      cap,
      spent: Number(spent.toFixed(2)),
      pct_spent: Number(pctSpent.toFixed(3)),
      pct_elapsed: Number(pctElapsed.toFixed(3)),
      severity,
      message: messageFor({ severity, period: budget.period, pctSpent, pctElapsed }),
    });
  }
  out.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return out;
}

function messageFor({ severity, period, pctSpent, pctElapsed }) {
  const pct = Math.round(pctSpent * 100);
  if (severity === "exceeded") return `${period} budget exceeded by ${pct - 100}%`;
  if (severity === "critical") return `${pct}% of ${period} budget used`;
  if (severity === "warning") return `${pct}% of ${period} budget used`;
  return `Spending ahead of pace: ${pct}% spent vs ${Math.round(pctElapsed * 100)}% elapsed`;
}

function severityRank(s) {
  return { exceeded: 4, critical: 3, warning: 2, pace: 1, ok: 0 }[s] ?? 0;
}
