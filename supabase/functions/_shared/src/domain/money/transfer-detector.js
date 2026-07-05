// Detects internal transfers: a debit on one account on day D and an equal
// credit on a different account between D-1 and D+1.
// Inputs: list of ledger-row-like objects { id, amount, direction,
// description, occurred_at, account?, merchant? }.
// Returns list of pairs: { debit, credit, reason }.

const TRANSFER_PHRASES = [
  /\btransfer\b/i,
  /\bneft\b/i,
  /\brtgs\b/i,
  /\bimps\b/i,
  /\bupi\b/i,
  /\bself\b/i,
  /\bto\s+self\b/i,
  /\bown\b/i,
  /\bsweep\b/i,
];

function within(a, b, hours = 36) {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs(da - db) <= hours * 3_600_000;
}

export function detectTransfers(rows) {
  const debits = rows.filter((r) => r.direction === "expense");
  const credits = rows.filter((r) => r.direction === "income");
  const used = new Set();
  const pairs = [];
  for (const d of debits) {
    const dAmt = Math.abs(Number(d.amount));
    for (const c of credits) {
      if (used.has(c.id)) continue;
      const cAmt = Math.abs(Number(c.amount));
      if (Math.abs(dAmt - cAmt) > 1) continue;
      if (!within(d.occurred_at, c.occurred_at, 36)) continue;
      const reason = explainPair(d, c);
      if (!reason) continue;
      pairs.push({ debit: d, credit: c, reason });
      used.add(c.id);
      break;
    }
  }
  return pairs;
}

function explainPair(d, c) {
  const desc = `${d.description || ""} ${c.description || ""}`;
  if (d.account && c.account && d.account !== c.account) return "paired_accounts";
  if (TRANSFER_PHRASES.some((rx) => rx.test(desc))) return "transfer_keyword";
  if ((d.merchant || "").toLowerCase() === (c.merchant || "").toLowerCase() && d.merchant) return "same_merchant";
  return null;
}
