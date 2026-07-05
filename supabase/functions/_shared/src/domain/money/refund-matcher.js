// Matches refund credits back to original debits.
// A refund typically has: direction=income, merchant matches an earlier debit
// from the same merchant within the last 60 days, amount within ±2 INR or
// ±5%.
// Returns pairs { refund, original, score }.

import { normalizeMerchant, dateDistanceDays } from "../../../lib/agent-core.mjs";

const MAX_WINDOW_DAYS = 60;

export function matchRefunds(rows) {
  const credits = rows.filter((r) => r.direction === "income");
  const debits = rows.filter((r) => r.direction === "expense");
  const pairs = [];
  for (const refund of credits) {
    const refundAmt = Math.abs(Number(refund.amount));
    const refundMerchant = normalizeMerchant(refund.merchant || "");
    if (!refundMerchant) continue;
    let best = null;
    for (const original of debits) {
      if (dateDistanceDays(original.occurred_at, refund.occurred_at) > MAX_WINDOW_DAYS) continue;
      if (new Date(original.occurred_at) > new Date(refund.occurred_at)) continue;
      const origMerchant = normalizeMerchant(original.merchant || "");
      if (!origMerchant) continue;
      if (!sameMerchant(refundMerchant, origMerchant)) continue;
      const origAmt = Math.abs(Number(original.amount));
      const tol = Math.max(2, origAmt * 0.05);
      if (Math.abs(origAmt - refundAmt) > tol) continue;
      const score = scorePair(refund, original);
      if (!best || score > best.score) best = { refund, original, score };
    }
    if (best && best.score >= 0.55) pairs.push(best);
  }
  return pairs;
}

function sameMerchant(a, b) {
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function scorePair(refund, original) {
  const refundAmt = Math.abs(Number(refund.amount));
  const origAmt = Math.abs(Number(original.amount));
  let score = 0;
  if (Math.abs(refundAmt - origAmt) <= 2) score += 0.55;
  else if (Math.abs(refundAmt - origAmt) / origAmt <= 0.05) score += 0.4;
  const days = dateDistanceDays(refund.occurred_at, original.occurred_at);
  if (days <= 7) score += 0.25;
  else if (days <= 30) score += 0.15;
  if (normalizeMerchant(refund.merchant) === normalizeMerchant(original.merchant)) score += 0.15;
  return Math.min(1, score);
}
