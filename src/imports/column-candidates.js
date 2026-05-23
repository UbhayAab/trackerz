// Canonical → raw header candidates for Indian bank statement formats.
// More entries are better than fewer because matching is fuzzy + first-hit.

export const columnCandidates = {
  date: [
    "date", "txn date", "transaction date", "value date", "posted date",
    "tran date", "post date", "trans date", "narration date", "txn dt",
  ],
  description: [
    "description", "narration", "particulars", "remarks", "merchant",
    "transaction details", "details", "transaction", "transaction remark",
    "transaction description", "txn description", "narration / description",
  ],
  debit: [
    "debit", "withdrawal", "withdrawal amt", "withdrawal amount",
    "paid out", "dr", "debit amount", "debit (rs.)", "debit ₹", "withdrawals",
  ],
  credit: [
    "credit", "deposit", "deposit amt", "deposit amount",
    "paid in", "cr", "credit amount", "credit (rs.)", "credit ₹", "deposits",
  ],
  amount: [
    "amount", "transaction amount", "signed amount", "txn amount",
    "amount (inr)", "amount (rs)", "amount in inr", "amount(₹)",
  ],
  balance: [
    "balance", "closing balance", "running balance", "available balance",
    "balance amt", "balance (inr)", "balance after txn",
  ],
  reference: [
    "reference", "ref", "utr", "upi ref", "upi reference", "transaction id",
    "cheque no", "cheque number", "chq no", "ref no", "ref #", "ref id",
    "transaction ref", "txn ref", "rrn",
  ],
  account: [
    "account", "account no", "account number", "ac no", "from account",
    "to account", "from", "to",
  ],
  mode: [
    "mode", "type", "txn type", "transaction type", "channel",
  ],
};

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Walks a header row and returns a mapping { canonicalKey: rawHeader, ... }
// for the headers we recognise. Missing canonical keys are simply absent.
export function autoMapColumns(headers = []) {
  const norm = headers.map(normalize);
  const out = {};
  for (const [canonical, candidates] of Object.entries(columnCandidates)) {
    let found = null;
    for (const cand of candidates) {
      const idx = norm.indexOf(cand);
      if (idx >= 0) { found = headers[idx]; break; }
    }
    if (!found) {
      for (let i = 0; i < norm.length; i++) {
        if (candidates.some((c) => norm[i].includes(c))) { found = headers[i]; break; }
      }
    }
    if (found) out[canonical] = found;
  }
  return out;
}

// Confidence: 0 (no useful columns) .. 1 (date + amount + descr present).
export function mappingConfidence(mapping = {}) {
  const required = ["date", "description"];
  const moneyHit = mapping.amount || (mapping.debit && mapping.credit);
  if (!required.every((k) => mapping[k])) return 0;
  if (!moneyHit) return 0.3;
  return 1;
}
