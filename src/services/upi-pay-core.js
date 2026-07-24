// Pure helpers for pay-from-app. NO bridge, NO Supabase, NO DOM - testable in
// plain Node (tests/upi-pay.test.mjs). Split out from upi-pay.js.

const VPA_RE = /^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/i; // handle@bank, the UPI address shape

/** Validate the minimum a UPI intent needs. Returns { ok, reason }. */
export function validatePayInput({ vpa, amount } = {}) {
  if (!vpa || !VPA_RE.test(String(vpa).trim())) return { ok: false, reason: "bad_vpa" };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: "bad_amount" };
  if (amt > 100000) return { ok: false, reason: "amount_too_large" }; // UPI P2P per-txn ceiling guard
  return { ok: true };
}

/** Amount as UPI wants it: a plain 2-decimal string, no grouping. */
export function formatAmount(amount) {
  return Number(amount).toFixed(2);
}

/**
 * Build the standard upi://pay deep link. Every value is URI-encoded. `ref` becomes
 * the `tr` (transaction reference) so a later bank SMS / response can be correlated.
 */
export function buildUpiUri({ vpa, name, amount, note, ref } = {}) {
  const q = new URLSearchParams();
  q.set("pa", String(vpa).trim());
  if (name) q.set("pn", String(name).trim());
  q.set("am", formatAmount(amount));
  q.set("cu", "INR");
  if (note) q.set("tn", String(note).trim());
  if (ref) q.set("tr", String(ref).trim());
  return `upi://pay?${q.toString()}`;
}

/**
 * The grounded capture string for a CONFIRMED payment. Includes the txn reference
 * so cross-source dedupe can merge it with the bank SMS for the same payment.
 */
export function paymentToCaptureText({ amount, name, vpa, note, txnRef } = {}) {
  const parts = ["Paid", `Rs ${Number(amount)}`, `to ${name || vpa}`];
  if (note) parts.push(`for ${note}`);
  if (txnRef) parts.push(`ref ${txnRef}`);
  return parts.join(" ");
}
