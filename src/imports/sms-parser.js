// Deterministic parser for Indian bank/UPI transaction SMS. Zero AI cost - used
// as a fast lane so a pasted/shared bank SMS becomes a clean, grounded capture
// string (or a ledger-ready object) before the agent ever runs.

const AMOUNT_RE = /(?:rs|inr|₹)\.?\s*([\d,]+(?:\.\d{1,2})?)/i;
const BALANCE_RE = /(?:avl|avbl|available|bal(?:ance)?)[^0-9₹]{0,12}(?:rs|inr|₹)?\.?\s*([\d,]+(?:\.\d{1,2})?)/i;
const ACCOUNT_RE = /(?:a\/c|ac|acct|account|card)\s*(?:no\.?)?\s*[xX*]+\s*(\d{3,4})/i;
const REF_RE = /(?:ref(?:erence)?(?:\s*no)?|utr|txn|upi\s*ref)\.?\s*:?\s*([A-Za-z0-9]{6,})/i;
const MERCHANT_RE = /(?:\bat\b|\bto\b|\bvpa\b|info:|towards)\s+([A-Za-z0-9][A-Za-z0-9 &._@-]{2,40})/i;

const DEBIT_WORDS = /\b(debit(?:ed)?|spent|withdrawn|paid|purchase|sent|deducted)\b/i;
// "credited" (the verb), NOT bare "credit" - otherwise "Credit Card" reads as an
// incoming credit and every credit-card purchase SMS becomes ambiguous and is dropped.
const CREDIT_WORDS = /\b(credited|received|deposited|refund(?:ed)?|salary|added)\b/i;

// Messages that CONTAIN an amount + a debit/credit word but did NOT move money.
// Booking these is phantom spend - the exact "logs things that never happened" bug.
// A future/scheduled mandate, a collect/payment request, or a declined/failed attempt.
const NON_TXN_RE = /\b(will\s+be\s+(?:debited|deducted|charged)|will\s+get\s+debited|is\s+due|due\s+on|scheduled(?:\s+for)?|standing\s+instruction|e-?mandate|has\s+requested|is\s+requesting|requesting\s+you|collect\s+request|payment\s+request|requested\s+money|payment\s+reminder|declined|failed|unsuccessful|insufficient|not\s+processed)\b/i;

// A debit that is NOT fresh spend: paying off a credit-card bill (the underlying
// swipes were already logged), or a self/own-account transfer. Booking these on top
// of the card swipes double-counts - the #1 over-count for a credit-card-first user.
const CC_BILL_RE = /\b(cred(?:\.club)?|billdesk|credit\s*card\s*(?:bill|payment|due)|card\s*bill|cc\s*bill|payment\s*towards\s*(?:your\s*)?card|towards\s*card\s*ending)\b/i;
const SELF_TRANSFER_RE = /\b(self\s*transfer|transfer(?:red)?\s*to\s*self|to\s*your\s*own\s*account|own\s*a\/?c|self\s*a\/?c)\b/i;

function num(value) {
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Heuristic: does this text look like a bank/UPI transaction at all?
//
// `trusted` relaxes the check for text that already comes from a known payment/bank
// source - a GPay/PhonePe notification ("You paid Rs 250 to Zepto") is a real
// payment even though it has no "a/c"/"bank"/"upi" keyword. For untrusted text
// (a raw SMS from anyone) we still require a banking word so a "paid Rs 200 for the
// movie" chat message is not mistaken for a transaction.
export function looksLikeBankSms(text, { trusted = false } = {}) {
  const t = String(text || "");
  if (!AMOUNT_RE.test(t)) return false;
  const hasDirection = DEBIT_WORDS.test(t) || CREDIT_WORDS.test(t);
  if (!hasDirection) return false;
  // A future/requested/declined message is not a completed transaction - drop it so
  // it never becomes phantom spend.
  if (NON_TXN_RE.test(t)) return false;
  if (trusted) return true;
  return /\b(a\/c|ac|account|card|upi|bank|bal)\b/i.test(t);
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

  // Classify non-spend debits so they are not double-counted against the card swipes
  // (cc_bill) or booked as spend at all (self-transfer). Only meaningful for debits.
  const txnType = direction === "expense"
    ? (CC_BILL_RE.test(t) ? "cc_bill" : SELF_TRANSFER_RE.test(t) ? "self_transfer" : "purchase")
    : "purchase";

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
    txnType,
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
