// Realistic cross-source duplicate matrix for the cases in §6 of the plan.
//
// All inputs are normalised ledger-row-like objects. Decisions:
//   merge      — strong duplicate, one canonical should win.
//   link       — likely the same event but keep both visible until user acts.
//   ignore     — definitely not duplicates.
//
// The function returns the strongest verdict for the pair.

import { normalizeMerchant } from "../../lib/agent-core.mjs";

const HARD_DUP_FIELDS = ["upi_ref", "utr", "reference", "external_ref"];

const TRANSFER_PHRASES = [/\btransfer\b/i, /\bneft\b/i, /\brtgs\b/i, /\bimps\b/i, /\bsweep\b/i, /\bself\b/i];

function hashRef(row) {
  for (const f of HARD_DUP_FIELDS) {
    if (row[f]) return String(row[f]).trim().toLowerCase();
  }
  return null;
}

function within(a, b, hours) {
  const diff = Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
  return diff <= hours;
}

export function classifyDuplicatePair(a, b) {
  const reasons = [];

  // 1. Hard ref match (same UPI ref / UTR / reference) → exact duplicate.
  const refA = hashRef(a);
  const refB = hashRef(b);
  if (refA && refB && refA === refB) {
    return { verdict: "merge", score: 1, reasons: ["hard_ref_match"] };
  }

  const amtA = Math.abs(Number(a.amount || 0));
  const amtB = Math.abs(Number(b.amount || 0));
  const merchantA = normalizeMerchant(a.merchant || a.description || "");
  const merchantB = normalizeMerchant(b.merchant || b.description || "");
  const sameMerchant = merchantA && merchantB && (merchantA === merchantB || merchantA.includes(merchantB) || merchantB.includes(merchantA));

  // 2. Internal transfer (checked BEFORE refund so transfer keywords win).
  if (a.direction && b.direction && a.direction !== b.direction && Math.abs(amtA - amtB) <= 1 && within(a.occurred_at, b.occurred_at, 36)) {
    const both = `${a.description || ""} ${b.description || ""} ${a.merchant || ""} ${b.merchant || ""}`;
    const diffAccount = a.account && b.account && a.account !== b.account;
    const transferWord = TRANSFER_PHRASES.some((rx) => rx.test(both));
    if (diffAccount || transferWord) {
      return { verdict: "link", score: 0.92, reasons: ["transfer"], linkKind: "transfer" };
    }
  }

  // 3. Refund (paired opposite directions, same merchant, near amount, no transfer signal).
  if (a.direction && b.direction && a.direction !== b.direction && sameMerchant) {
    const tol = Math.max(2, Math.min(amtA, amtB) * 0.05);
    if (Math.abs(amtA - amtB) <= tol) {
      reasons.push("refund_pair");
      return { verdict: "link", score: 0.85, reasons, linkKind: "refund" };
    }
  }

  // 4. Same direction, same merchant, same amount, same hour → strong duplicate.
  if (a.direction === b.direction && sameMerchant && amtA && amtB && Math.abs(amtA - amtB) <= 1 && within(a.occurred_at, b.occurred_at, 1)) {
    return { verdict: "merge", score: 0.93, reasons: ["same_event"], canonical: prefer(a, b) };
  }

  // 5. Same direction, same merchant, "Rs 250 voice vs Rs 252 bank" pattern.
  if (a.direction === b.direction && sameMerchant && amtA && amtB) {
    const rel = Math.abs(amtA - amtB) / Math.max(amtA, amtB);
    if ((rel <= 0.04 || Math.abs(amtA - amtB) <= 5) && within(a.occurred_at, b.occurred_at, 4)) {
      return { verdict: "link", score: 0.78, reasons: ["voice_vs_bank"], canonical: prefer(a, b) };
    }
  }

  // 6. Sum-of-items match: a + a2 + ... ≈ b (e.g. voice "lunch 250 + chai 30" vs bank "ZOMATO 280").
  //    Handled at a higher level (see clusterByPossibleSum).

  // 7. Different days same merchant same amount → DO NOT merge (recurring expense).
  if (a.direction === b.direction && sameMerchant && Math.abs(amtA - amtB) <= 1 && !within(a.occurred_at, b.occurred_at, 6)) {
    return { verdict: "ignore", score: 0.4, reasons: ["recurring_expense"] };
  }

  return { verdict: "ignore", score: 0, reasons: ["no_strong_signal"] };
}

// Pick the row that should survive a merge.
function prefer(a, b) {
  // Bank statement / spreadsheet is canonical over screenshot / voice / text.
  const sourceRank = { bank: 4, file: 4, image: 3, audio: 2, text: 1, mixed: 1 };
  const rA = sourceRank[a.source_type] || 0;
  const rB = sourceRank[b.source_type] || 0;
  if (rA !== rB) return rA > rB ? a : b;
  if (a.reference && !b.reference) return a;
  if (b.reference && !a.reference) return b;
  return a;
}

// Cluster rows that look like sub-items of one bank transaction.
// Returns groups: { parent, items: [child...], sumAmount, diff }.
export function clusterByPossibleSum(rows) {
  const tolerance = 5; // INR
  const parents = rows.filter((r) => r.source_type === "bank" || r.source_type === "file");
  const children = rows.filter((r) => ["text", "audio", "image", "mixed"].includes(r.source_type));
  const groups = [];
  for (const parent of parents) {
    const parentAmt = Math.abs(Number(parent.amount || 0));
    if (!parentAmt) continue;
    const sameMerchant = children.filter((c) => sameMerchantPair(parent, c));
    if (sameMerchant.length < 2) continue;
    const sums = subsetsSum(sameMerchant.map((c) => Math.abs(Number(c.amount || 0))));
    for (const subset of sums) {
      if (Math.abs(subset.total - parentAmt) <= tolerance) {
        const items = subset.indices.map((i) => sameMerchant[i]);
        groups.push({ parent, items, sumAmount: subset.total, diff: subset.total - parentAmt });
        break;
      }
    }
  }
  return groups;
}

function sameMerchantPair(a, b) {
  const mA = normalizeMerchant(a.merchant || a.description || "");
  const mB = normalizeMerchant(b.merchant || b.description || "");
  return mA && mB && (mA === mB || mA.includes(mB) || mB.includes(mA));
}

function subsetsSum(arr) {
  const n = Math.min(arr.length, 6);
  const out = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    let total = 0;
    const indices = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { total += arr[i]; indices.push(i); }
    }
    if (indices.length >= 2) out.push({ total, indices });
  }
  return out;
}
