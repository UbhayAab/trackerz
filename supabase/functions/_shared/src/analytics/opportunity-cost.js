// Opportunity cost: if your discretionary spend had been invested in Nifty 50
// on the day you spent it, how much would it be worth today?
//
// Uses a coarse monthly-close series so we don't need a daily API. The series
// is good enough to motivate, not to advise.

import { NIFTY_MONTHLY_CLOSES } from "../data/nifty-monthly-closes.js";

const SORTED_MONTHS = Object.keys(NIFTY_MONTHLY_CLOSES).sort();

function latestKnownClose() {
  const lastMonth = SORTED_MONTHS[SORTED_MONTHS.length - 1];
  return { month: lastMonth, close: NIFTY_MONTHLY_CLOSES[lastMonth] };
}

function closestPreviousClose(monthKey) {
  if (NIFTY_MONTHLY_CLOSES[monthKey] != null) return NIFTY_MONTHLY_CLOSES[monthKey];
  for (let i = SORTED_MONTHS.length - 1; i >= 0; i--) {
    if (SORTED_MONTHS[i] <= monthKey) return NIFTY_MONTHLY_CLOSES[SORTED_MONTHS[i]];
  }
  return NIFTY_MONTHLY_CLOSES[SORTED_MONTHS[0]];
}

function monthKeyOf(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function computeOpportunityCost(ledgerEntries) {
  const latest = latestKnownClose();
  const latestClose = latest.close;

  let totalSpent = 0;
  let hypotheticalNow = 0;
  let count = 0;

  for (const entry of ledgerEntries) {
    if (entry.direction !== "expense") continue;
    if (!entry.is_discretionary) continue;
    const amt = Number(entry.amount || 0);
    if (!amt) continue;
    const mk = monthKeyOf(entry.occurred_at);
    if (!mk) continue;
    const buyClose = closestPreviousClose(mk);
    if (!buyClose) continue;
    totalSpent += amt;
    hypotheticalNow += amt * (latestClose / buyClose);
    count += 1;
  }

  const gain = hypotheticalNow - totalSpent;
  const pct = totalSpent > 0 ? (gain / totalSpent) * 100 : 0;
  return {
    totalSpent: Math.round(totalSpent),
    hypotheticalNow: Math.round(hypotheticalNow),
    gain: Math.round(gain),
    pct: Number(pct.toFixed(1)),
    count,
    referenceMonth: latest.month,
  };
}
