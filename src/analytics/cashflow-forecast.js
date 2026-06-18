// Forward-looking cashflow: "safe to spend today" and projected month-end spend.
// Pure functions over ledger + budgets + subscriptions. No AI, no IO.

function startOfMonth(today) {
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function daysInMonth(today) {
  const d = new Date(today);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function monthlyCapFrom(budgets) {
  const overall = (budgets || []).find((b) => b.period === "monthly" && !b.category_id);
  if (overall) return Number(overall.amount) || 0;
  return (budgets || [])
    .filter((b) => b.period === "monthly")
    .reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
}

function spentThisMonth(ledger, today) {
  const start = startOfMonth(today).getTime();
  const now = new Date(today).getTime();
  return (ledger || [])
    .filter((r) => r.direction === "expense")
    .filter((r) => {
      const t = new Date(r.occurred_at).getTime();
      return t >= start && t <= now;
    })
    .reduce((sum, r) => sum + Math.abs(Number(r.amount) || 0), 0);
}

// Subscriptions expected to charge between now and month end.
function upcomingSubsThisMonth(subscriptions, today) {
  const now = new Date(today).getTime();
  const monthEnd = new Date(new Date(today).getFullYear(), new Date(today).getMonth() + 1, 0, 23, 59, 59).getTime();
  return (subscriptions || []).reduce((sum, s) => {
    if (!s.next_expected_at) return sum;
    const t = new Date(s.next_expected_at).getTime();
    return t >= now && t <= monthEnd ? sum + (Number(s.median_amount) || 0) : sum;
  }, 0);
}

export function safeToSpendToday({ ledger = [], budgets = [], subscriptions = [], today = new Date() } = {}) {
  const monthlyCap = monthlyCapFrom(budgets);
  const spent = spentThisMonth(ledger, today);
  const upcoming = upcomingSubsThisMonth(subscriptions, today);
  const dayOfMonth = new Date(today).getDate();
  const daysLeft = Math.max(1, daysInMonth(today) - dayOfMonth + 1);
  const remaining = monthlyCap - spent - upcoming;
  const perDay = monthlyCap > 0 ? Math.max(0, Math.round(remaining / daysLeft)) : 0;
  return {
    monthlyCap: Math.round(monthlyCap),
    spent: Math.round(spent),
    upcoming: Math.round(upcoming),
    remaining: Math.round(remaining),
    daysLeft,
    perDay,
    hasBudget: monthlyCap > 0,
  };
}

// Linear projection of where this month's spend lands at the current pace.
export function projectMonthEndSpend({ ledger = [], today = new Date() } = {}) {
  const spent = spentThisMonth(ledger, today);
  const dayOfMonth = new Date(today).getDate();
  const total = daysInMonth(today);
  const projected = dayOfMonth > 0 ? Math.round((spent / dayOfMonth) * total) : 0;
  return { spent: Math.round(spent), projected, dayOfMonth, daysInMonth: total };
}

// What-if: reduce discretionary spend pace by a fraction for the rest of the
// month. Returns the projected month-end spend under that change.
export function simulateDiscretionaryCut({ ledger = [], today = new Date(), reduceFraction = 0.5 } = {}) {
  const start = startOfMonth(today).getTime();
  const now = new Date(today).getTime();
  const monthRows = (ledger || []).filter((r) => r.direction === "expense").filter((r) => {
    const t = new Date(r.occurred_at).getTime();
    return t >= start && t <= now;
  });
  const discretionary = monthRows.filter((r) => r.is_discretionary).reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);
  const essential = monthRows.filter((r) => !r.is_discretionary).reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);
  const dayOfMonth = new Date(today).getDate();
  const total = daysInMonth(today);
  const daysLeft = Math.max(0, total - dayOfMonth);
  const discPerDay = dayOfMonth > 0 ? discretionary / dayOfMonth : 0;
  const essPerDay = dayOfMonth > 0 ? essential / dayOfMonth : 0;
  const projected = Math.round(
    discretionary + essential + (discPerDay * (1 - reduceFraction) + essPerDay) * daysLeft,
  );
  const baseline = projectMonthEndSpend({ ledger, today }).projected;
  return { baseline, projected, saved: Math.max(0, baseline - projected), reduceFraction };
}
