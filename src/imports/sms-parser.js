// Deterministic parser for Indian bank/UPI transaction SMS. Zero AI cost - used
// as a fast lane so a pasted/shared bank SMS becomes a clean, grounded capture
// string (or a ledger-ready object) before the agent ever runs.

const AMOUNT_RE = /(?:rs|inr|₹)\.?\s*([\d,]+(?:\.\d{1,2})?)/i;
const BALANCE_RE = /(?:avl|avbl|available|bal(?:ance)?)[^0-9₹]{0,12}(?:rs|inr|₹)?\.?\s*([\d,]+(?:\.\d{1,2})?)/i;
const ACCOUNT_RE = /(?:a\/c|ac|acct|account|card)\s*(?:no\.?)?\s*[xX*]+\s*(\d{3,4})/i;
const REF_RE = /(?:ref(?:erence)?(?:\s*no)?|utr|txn|upi\s*ref)\.?\s*:?\s*([A-Za-z0-9]{6,})/i;
const MERCHANT_RE = /(?:\bat\b|\bto\b|\bvpa\b|info:|towards)\s+([A-Za-z0-9][A-Za-z0-9 &._@-]{2,40})/i;

const DEBIT_WORDS = /\b(debit(?:ed)?|spent|withdrawn|paid|purchase|sent|deducted)\b/i;
const CREDIT_WORDS = /\b(credit(?:ed)?|received|deposited|refund(?:ed)?|salary|added)\b/i;

function num(value) {
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Heuristic: does this text look like a bank/UPI SMS at all?
export function looksLikeBankSms(text) {
  const t = String(text || "");
  if (!AMOUNT_RE.test(t)) return false;
  return (DEBIT_WORDS.test(t) || CREDIT_WORDS.test(t)) && /\b(a\/c|ac|account|card|upi|bank|bal)\b/i.test(t);
}

export function parseBankSms(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const amountMatch = t.match(AMOUNT_RE);
  if (!amountMatch) return { ok: false, reason: "no_amount" };

  const balanceMatch = t.match(BALANCE_RE);
  const balanceStr = balanceMatch ? balanceMatch[1] : null;
  // Make sure we don't read the available-balance figure as the amount.
  let amount = num(amountMatch[1]);
  if (balanceStr && amountMatch[1].replace(/,/g, "") === balanceStr.replace(/,/g, "")) {
    // The first Rs match was the balance; find the next distinct amount.
    const all = [...t.matchAll(new RegExp(AMOUNT_RE.source, "gi"))].map((m) => m[1]);
    const distinct = all.find((a) => a.replace(/,/g, "") !== balanceStr.replace(/,/g, ""));
    amount = distinct ? num(distinct) : amount;
  }

  const isDebit = DEBIT_WORDS.test(t);
  const isCredit = CREDIT_WORDS.test(t);
  const direction = isDebit && !isCredit ? "expense" : isCredit && !isDebit ? "income" : null;

  const accountMatch = t.match(ACCOUNT_RE);
  const refMatch = t.match(REF_RE);
  const merchantMatch = t.match(MERCHANT_RE);
  const merchant = merchantMatch ? merchantMatch[1].trim().replace(/\s+(on|ref|upi|info).*$/i, "").trim() : null;

  // Confidence reflects how many load-bearing fields we recovered.
  let confidence = 0.4;
  if (amount) confidence += 0.25;
  if (direction) confidence += 0.15;
  if (merchant) confidence += 0.1;
  if (refMatch) confidence += 0.1;

  return {
    ok: Boolean(amount),
    amount,
    direction,
    merchant,
    accountSuffix: accountMatch ? accountMatch[1] : null,
    reference: refMatch ? refMatch[1] : null,
    balance: balanceStr ? num(balanceStr) : null,
    confidence: Number(Math.min(1, confidence).toFixed(2)),
  };
}

// Normalize a parsed SMS into a clean capture string. Every figure here is
// grounded in the source SMS, so the agent's evidence guard passes naturally.
export function smsToCaptureText(parsed) {
  if (!parsed?.ok) return "";
  const parts = [];
  if (parsed.direction === "income") parts.push("Received");
  else parts.push("Paid");
  parts.push(`Rs ${parsed.amount}`);
  if (parsed.merchant) parts.push(parsed.direction === "income" ? `from ${parsed.merchant}` : `to ${parsed.merchant}`);
  if (parsed.accountSuffix) parts.push(`from a/c x${parsed.accountSuffix}`);
  if (parsed.reference) parts.push(`ref ${parsed.reference}`);
  return parts.join(" ");
}
