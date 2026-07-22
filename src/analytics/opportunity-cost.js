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

function fmtRupees(n) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export function computeOpportunityCost(ledgerEntries) {
  const latest = latestKnownClose();
  const latestClose = latest.close;

  let totalSpent = 0;
  let hypotheticalNow = 0;
  let count = 0;
  // Spend that post-dates the last close we have. The series stops at a month
  // end and the user keeps spending after it, so there is no benchmark to grow
  // this money by - it is held at cost (a 1.0 multiplier) and disclosed rather
  // than quietly folded in as if it had been measured.
  let unpricedSpent = 0;
  let unpricedCount = 0;

  for (const entry of ledgerEntries) {
    if (entry.direction !== "expense") continue;
    if (!entry.is_discretionary) continue;
    const amt = Number(entry.amount || 0);
    if (!amt) continue;
    const mk = monthKeyOf(entry.occurred_at);
    if (!mk) continue;
    const priced = mk <= latest.month;
    const buyClose = closestPreviousClose(mk);
    if (!buyClose) continue;
    totalSpent += amt;
    count += 1;
    if (priced) {
      hypotheticalNow += amt * (latestClose / buyClose);
    } else {
      hypotheticalNow += amt;
      unpricedSpent += amt;
      unpricedCount += 1;
    }
  }

  const pricedSpent = totalSpent - unpricedSpent;
  const gain = hypotheticalNow - totalSpent;
  const pct = totalSpent > 0 ? (gain / totalSpent) * 100 : 0;
  // The return on the part the benchmark actually covers, undiluted by the
  // held-at-cost remainder.
  const pricedPct = pricedSpent > 0 ? (gain / pricedSpent) * 100 : 0;

  return {
    totalSpent: Math.round(totalSpent),
    hypotheticalNow: Math.round(hypotheticalNow),
    gain: Math.round(gain),
    pct: Number(pct.toFixed(1)),
    count,
    referenceMonth: latest.month,
    pricedSpent: Math.round(pricedSpent),
    pricedCount: count - unpricedCount,
    pricedPct: Number(pricedPct.toFixed(1)),
    unpricedSpent: Math.round(unpricedSpent),
    unpricedCount,
    // Render this verbatim wherever the headline number is shown; null means
    // every rupee in the figure is benchmarked.
    disclosure: unpricedCount
      ? `${fmtRupees(unpricedSpent)} of this (${unpricedCount} expense${unpricedCount > 1 ? "s" : ""}) was spent after ${latest.month}, the last Nifty close on file, so it is held at cost rather than grown.`
      : null,
  };
}
