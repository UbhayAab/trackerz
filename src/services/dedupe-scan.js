// Cross-source duplicate scanner. Runs after a capture to compare the latest
// ledger entries against the user's history and flag likely duplicates.
//
// Handles the "Rs 250 said in voice / Rs 252 in bank statement same lunch"
// case by allowing both an absolute (<= Rs 5) and a relative (<= 3%) amount
// gap when the events fall in the same time bucket.

import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import { scorePair, MIN_SCORE_TO_FLAG } from "../duplicates/score-pair.js";

const TIME_BUCKET_HOURS = 4;

export { scorePair };

export async function runCrossSourceDedupe({ since } = {}) {
  const session = getCurrentSession();
  if (!session?.user?.id) return { pairs: 0 };
  const supabase = await getSupabaseClient();

  const sinceIso = since || new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: recent, error: recentErr } = await supabase
    .from("ledger_entries")
    .select("id, amount, currency, merchant, description, occurred_at, direction, ingestion_id")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  // This scan silently returning {pairs:0} looks identical whether it found nothing
  // or it errored — that already cost one duplicate-detection feature going dark
  // for 3+ weeks unnoticed (found 2026-07-04). Log every failure loudly so the next
  // one is visible in devtools instead of indistinguishable from "no duplicates".
  if (recentErr) { console.error("[dedupe-scan] fetch recent ledger_entries failed:", recentErr); return { pairs: 0, error: recentErr }; }
  if (!recent?.length) return { pairs: 0 };

  const earliest = recent.reduce((min, r) => (r.occurred_at < min ? r.occurred_at : min), recent[0].occurred_at);
  const windowStart = new Date(new Date(earliest).getTime() - TIME_BUCKET_HOURS * 3_600_000).toISOString();
  const windowEnd = new Date(new Date(Math.max(...recent.map((r) => new Date(r.occurred_at).getTime()))).getTime() + TIME_BUCKET_HOURS * 3_600_000).toISOString();

  const { data: candidates, error: candErr } = await supabase
    .from("ledger_entries")
    .select("id, amount, currency, merchant, description, occurred_at, direction, ingestion_id")
    .gte("occurred_at", windowStart)
    .lte("occurred_at", windowEnd);
  if (candErr) { console.error("[dedupe-scan] fetch candidate ledger_entries failed:", candErr); return { pairs: 0, error: candErr }; }

  const inserts = [];
  const seenPairs = new Set();

  for (const a of recent) {
    for (const b of candidates) {
      if (a.id === b.id) continue;
      if (a.ingestion_id && b.ingestion_id && a.ingestion_id === b.ingestion_id) continue;
      const pairKey = [a.id, b.id].sort().join("::");
      if (seenPairs.has(pairKey)) continue;
      const score = scorePair(a, b);
      if (score.score >= MIN_SCORE_TO_FLAG) {
        seenPairs.add(pairKey);
        inserts.push({
          user_id: session.user.id,
          domain: "money",
          record_a_table: "ledger_entries",
          record_a_id: a.id,
          record_b_table: "ledger_entries",
          record_b_id: b.id,
          score: score.score,
          reason: score.reasons.join(","),
          status: "open",
        });
      }
    }
  }

  if (!inserts.length) return { pairs: 0 };

  const { error: insErr } = await supabase
    .from("duplicate_candidates")
    .insert(inserts);
  if (insErr) { console.error("[dedupe-scan] insert into duplicate_candidates failed:", insErr); return { pairs: 0, error: insErr }; }
  return { pairs: inserts.length };
}
