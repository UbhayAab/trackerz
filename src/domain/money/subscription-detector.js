// Finds recurring expense clusters that look like subscriptions.
// Heuristic: group by normalized merchant; in each group, if there are >= 3
// debits at ~monthly cadence (24-34 days apart) with similar amounts (within
// 10% of the median), treat as a subscription and forecast the next charge.

import { normalizeMerchant } from "../../../lib/agent-core.mjs";

const MIN_OCCURRENCES = 3;
const MIN_CADENCE_DAYS = 24;
const MAX_CADENCE_DAYS = 34;
const AMOUNT_TOLERANCE = 0.1;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function daysBetween(a, b) {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

export function detectSubscriptions(rows) {
  const debits = rows.filter((r) => r.direction === "expense");
  const groups = new Map();
  for (const row of debits) {
    const key = normalizeMerchant(row.merchant || row.description || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const subs = [];
  for (const [merchant, items] of groups.entries()) {
    if (items.length < MIN_OCCURRENCES) continue;
    items.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
    const amounts = items.map((i) => Math.abs(Number(i.amount)));
    const med = median(amounts);
    if (!med) continue;
    const tight = amounts.filter((a) => Math.abs(a - med) / med <= AMOUNT_TOLERANCE);
    if (tight.length < MIN_OCCURRENCES) continue;
    const cadences = [];
    for (let i = 1; i < items.length; i++) {
      cadences.push(daysBetween(items[i - 1].occurred_at, items[i].occurred_at));
    }
    const medCadence = median(cadences);
    if (medCadence < MIN_CADENCE_DAYS || medCadence > MAX_CADENCE_DAYS) continue;
    const last = items[items.length - 1];
    const nextExpected = new Date(new Date(last.occurred_at).getTime() + medCadence * 86_400_000);
    subs.push({
      merchant,
      sample_count: items.length,
      median_amount: Number(med.toFixed(2)),
      cadence_days: Number(medCadence.toFixed(1)),
      next_expected_at: nextExpected.toISOString(),
      first_seen_at: items[0].occurred_at,
      last_seen_at: last.occurred_at,
      member_ids: items.map((i) => i.id).filter(Boolean),
    });
  }
  return subs;
}
