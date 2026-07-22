// Cross-source duplicate scanner. Runs after a capture to compare the latest
// ledger entries against the user's history and flag likely duplicates.
//
// Handles the "Rs 250 said in voice / Rs 252 in bank statement same lunch"
// case by allowing both an absolute (<= Rs 5) and a relative (<= 3%) amount
// gap when the events fall in the same time bucket.

import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import { scorePair, MIN_SCORE_TO_FLAG } from "../duplicates/score-pair.js";
import { clusterExpenseSubsetSums } from "../duplicates/expense-duplicates.js";

const TIME_BUCKET_HOURS = 4;
const SELECT_COLUMNS = "id, amount, currency, merchant, description, occurred_at, direction, ingestion_id, source_type, merged_into";

// A capture applied twice writes rows carrying the SAME ingestion_id, so the
// old "skip pairs from one ingestion" rule made the 2026-07-09 triple-apply
// (Rs 80, then Rs 20 + Rs 60, then Rs 20 + Rs 60 again - Rs 240 booked for an
// Rs 80 purchase) structurally invisible to this scan. One ingestion CAN also
// legitimately produce several distinct rows ("20 for lays AND 60 for eggs"),
// so same-ingestion pairs are admitted only on a re-application signature:
// identical amount and direction, close in time. Anything looser would flag
// every multi-item capture as a duplicate of itself.
const SAME_INGESTION_REAPPLY_HOURS = 24;

// Subset-sum groups are structural evidence (one row equals the sum of others),
// not a fuzzy score, so they sit just above the flag threshold; an exact sum
// scores higher than one that needed the rounding tolerance.
const SUBSET_SUM_SCORE_EXACT = 0.78;
const SUBSET_SUM_SCORE_NEAR = 0.68;

const MERGEABLE_TABLES = new Set(["ledger_entries"]); // the only table with a merged_into column

export { scorePair };

export function sameIngestionReapply(a, b) {
  const amtA = Number(a.amount || 0);
  const amtB = Number(b.amount || 0);
  if (!amtA || !amtB || amtA !== amtB) return false;
  if (a.direction !== b.direction) return false;
  const hours = Math.abs(new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()) / 3_600_000;
  return Number.isFinite(hours) && hours <= SAME_INGESTION_REAPPLY_HOURS;
}

export async function runCrossSourceDedupe({ since } = {}) {
  const session = getCurrentSession();
  if (!session?.user?.id) return { pairs: 0 };
  const supabase = await getSupabaseClient();

  const sinceIso = since || new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: recent, error: recentErr } = await supabase
    .from("ledger_entries")
    .select(SELECT_COLUMNS)
    .is("merged_into", null)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  // This scan silently returning {pairs:0} looks identical whether it found nothing
  // or it errored - that already cost one duplicate-detection feature going dark
  // for 3+ weeks unnoticed (found 2026-07-04). Log every failure loudly so the next
  // one is visible in devtools instead of indistinguishable from "no duplicates".
  if (recentErr) { console.error("[dedupe-scan] fetch recent ledger_entries failed:", recentErr); return { pairs: 0, error: recentErr }; }
  if (!recent?.length) return { pairs: 0 };

  const earliest = recent.reduce((min, r) => (r.occurred_at < min ? r.occurred_at : min), recent[0].occurred_at);
  const windowStart = new Date(new Date(earliest).getTime() - TIME_BUCKET_HOURS * 3_600_000).toISOString();
  const windowEnd = new Date(new Date(Math.max(...recent.map((r) => new Date(r.occurred_at).getTime()))).getTime() + TIME_BUCKET_HOURS * 3_600_000).toISOString();

  const { data: candidates, error: candErr } = await supabase
    .from("ledger_entries")
    .select(SELECT_COLUMNS)
    .is("merged_into", null)
    .gte("occurred_at", windowStart)
    .lte("occurred_at", windowEnd);
  if (candErr) { console.error("[dedupe-scan] fetch candidate ledger_entries failed:", candErr); return { pairs: 0, error: candErr }; }

  const inserts = [];
  const seenPairs = new Set();
  const addPair = (a, b, score, reason) => {
    const pairKey = [a.id, b.id].sort().join("::");
    if (seenPairs.has(pairKey)) return false;
    seenPairs.add(pairKey);
    inserts.push({
      user_id: session.user.id,
      domain: "money",
      record_a_table: "ledger_entries",
      record_a_id: a.id,
      record_b_table: "ledger_entries",
      record_b_id: b.id,
      score,
      reason,
      status: "open",
    });
    return true;
  };

  for (const a of recent) {
    for (const b of candidates) {
      if (a.id === b.id) continue;
      const sameIngestion = Boolean(a.ingestion_id && b.ingestion_id && a.ingestion_id === b.ingestion_id);
      if (sameIngestion && !sameIngestionReapply(a, b)) continue;
      const score = scorePair(a, b);
      if (score.score >= MIN_SCORE_TO_FLAG) {
        const reasons = sameIngestion ? [...score.reasons, "same_ingestion_reapply"] : score.reasons;
        addPair(a, b, score.score, reasons.join(","));
      }
    }
  }

  addSubsetSumPairs({ recent, candidates, addPair });

  if (!inserts.length) return { pairs: 0 };

  const { error: insErr } = await supabase
    .from("duplicate_candidates")
    .insert(inserts);
  if (insErr) { console.error("[dedupe-scan] insert into duplicate_candidates failed:", insErr); return { pairs: 0, error: insErr }; }
  return { pairs: inserts.length };
}

// duplicate_candidates stores PAIRS, so a group ("Rs 80 is Rs 20 + Rs 60") is
// emitted as one candidate per item, each against the parent. Resolving them
// all points every item at the same survivor, which is exactly the fix.
function addSubsetSumPairs({ recent, candidates, addPair }) {
  const byId = new Map();
  for (const row of [...(candidates || []), ...recent]) byId.set(row.id, row);
  const recentIds = new Set(recent.map((r) => r.id));

  for (const group of clusterExpenseSubsetSums([...byId.values()])) {
    // Only report a group the current capture actually touched, otherwise every
    // scan re-flags the same historical split.
    const touched = recentIds.has(group.parent.id) || group.items.some((i) => recentIds.has(i.id));
    if (!touched) continue;
    const exact = Math.abs(group.diff) < 0.005;
    const score = exact ? SUBSET_SUM_SCORE_EXACT : SUBSET_SUM_SCORE_NEAR;
    const reason = [group.reason, `${group.items.length}_items`, exact ? "exact_sum" : "near_sum"].join(",");
    for (const item of group.items) addPair(group.parent, item, score, reason);
  }
}

// Merge = one of the pair was a repeat capture of the same event. The loser is
// KEPT and stamped with merged_into so the audit trail still shows what was
// captured and when; hard-deleting it (what this used to do) destroyed the only
// record that the double-write ever happened. Every spend aggregation must
// therefore filter `.is("merged_into", null)` - a row that is merged but still
// summed is worse than a deleted one.
export async function mergeDuplicatePair({ candidateId, keepId, dropId, table = "ledger_entries" }) {
  if (!MERGEABLE_TABLES.has(table)) throw new Error(`merge not supported for ${table}`);
  if (!candidateId) throw new Error("merge needs the duplicate candidate id");
  if (!keepId || !dropId) throw new Error("merge needs both a survivor and a loser id");
  if (keepId === dropId) throw new Error("cannot merge a row into itself");
  const supabase = await getSupabaseClient();

  const { data: keepRow, error: keepErr } = await supabase
    .from(table).select("id, merged_into").eq("id", keepId).maybeSingle();
  if (keepErr) throw keepErr;
  if (!keepRow) throw new Error(`merge target ${keepId} no longer exists`);
  // If the survivor was itself merged earlier, point at the head of that chain:
  // a pointer to a superseded row would make the trail assert something untrue.
  const survivorId = keepRow.merged_into || keepRow.id;
  if (survivorId === dropId) throw new Error("merge would point a row at itself");

  const { data: merged, error: mergeErr } = await supabase
    .from(table)
    .update({ merged_into: survivorId, duplicate_state: "duplicate_loser" })
    .eq("id", dropId)
    .select("id");
  if (mergeErr) throw mergeErr;
  // RLS turns a forbidden update into a successful call that touched no rows.
  // Silence here would tell the user the duplicate is gone while the money is
  // still double-counted, so it has to raise.
  if (!merged?.length) throw new Error(`merge did not update ${table} ${dropId} (row missing or blocked by RLS)`);

  const { data: closed, error: candErr } = await supabase
    .from("duplicate_candidates")
    .update({ status: "resolved" })
    .eq("id", candidateId)
    .select("id");
  if (candErr) throw candErr;
  if (!closed?.length) throw new Error(`duplicate candidate ${candidateId} stayed open after merge`);

  return { survivorId, mergedId: dropId };
}
