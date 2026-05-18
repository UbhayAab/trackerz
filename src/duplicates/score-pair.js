import { normalizeMerchant } from "../../lib/agent-core.mjs";

const TIME_BUCKET_HOURS = 4;
const ABS_AMOUNT_TOLERANCE = 5;
const REL_AMOUNT_TOLERANCE = 0.03;
export const MIN_SCORE_TO_FLAG = 0.6;

export function scorePair(a, b) {
  const reasons = [];
  let score = 0;

  const amtA = Number(a.amount || 0);
  const amtB = Number(b.amount || 0);
  if (amtA && amtB) {
    const diff = Math.abs(amtA - amtB);
    const relDiff = diff / Math.max(amtA, amtB);
    if (diff === 0) {
      score += 0.45;
      reasons.push("exact_amount");
    } else if (diff <= ABS_AMOUNT_TOLERANCE || relDiff <= REL_AMOUNT_TOLERANCE) {
      score += 0.3;
      reasons.push("near_amount");
    }
  }

  if (a.direction && b.direction && a.direction === b.direction) {
    score += 0.05;
    reasons.push("same_direction");
  }

  const hoursApart = Math.abs(new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()) / 3_600_000;
  let hasTimeMatch = false;
  if (hoursApart <= 0.5) {
    score += 0.3;
    reasons.push("same_minute_window");
    hasTimeMatch = true;
  } else if (hoursApart <= TIME_BUCKET_HOURS) {
    score += 0.2;
    reasons.push("same_time_window");
    hasTimeMatch = true;
  }

  const mA = normalizeMerchant(a.merchant || a.description || "");
  const mB = normalizeMerchant(b.merchant || b.description || "");
  if (mA && mB) {
    if (mA === mB) {
      score += 0.2;
      reasons.push("same_merchant");
    } else if (mA.includes(mB) || mB.includes(mA)) {
      score += 0.12;
      reasons.push("merchant_substring");
    }
  }

  // Without a time-window match, "same merchant same amount different day"
  // is not a duplicate — it's a recurring expense. Cap below flag threshold.
  if (!hasTimeMatch) {
    score = Math.min(score, MIN_SCORE_TO_FLAG - 0.05);
  }

  return { score: Number(Math.min(1, score).toFixed(4)), reasons };
}
