// Pure decision logic for SMS auto-capture. NO bridge, NO Supabase, NO DOM - only
// the deterministic SMS parser. Split out from sms-capture.js so it is testable in
// plain Node (tests/sms-capture.test.mjs) without importing the capture pipeline.

import { looksLikeBankSms, parseBankSms, smsToCaptureText } from "../imports/sms-parser.js";

/** Small deterministic string hash (djb2). Stable across runs; not cryptographic. */
export function hashString(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * A stable idempotency key for one SMS. The UPI reference / UTR is globally unique
 * per payment, so prefer it; otherwise fall back to a hash of the sender + amount +
 * calendar day + the start of the body, which is stable for the same message but
 * still lets a genuinely repeated identical purchase on another day through.
 */
export function smsKey(msg, parsed) {
  if (parsed?.reference) return `ref:${String(parsed.reference).toLowerCase()}`;
  const day = String(msg?.dateIso || "").slice(0, 10);
  const body = String(msg?.body || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `h:${hashString(`${msg?.address || ""}|${parsed?.amount ?? ""}|${day}|${body}`)}`;
}

/**
 * Decide whether one SMS should become a capture. Returns
 *   { ok:true, key, text, parsed }  when it is a real debit/credit, or
 *   { ok:false, reason }            otherwise (not a bank SMS, no amount, ambiguous).
 * Ambiguous-direction messages (neither clearly debit nor credit) are skipped -
 * logging them would guess, and a wrong-signed ledger row is worse than a miss.
 */
export function captureFromSms(msg) {
  const body = msg?.body || "";
  // A message from a known payment/bank app (source "notification") is trusted, so
  // "You paid Rs 250 to Zepto" counts even without a banking keyword. A raw SMS is
  // not trusted and must carry one.
  const trusted = msg?.trusted === true || msg?.source === "notification";
  if (!looksLikeBankSms(body, { trusted })) return { ok: false, reason: "not_bank_sms" };
  const parsed = parseBankSms(body);
  if (!parsed.ok || !parsed.amount) return { ok: false, reason: "no_amount" };
  if (parsed.direction !== "expense" && parsed.direction !== "income") {
    return { ok: false, reason: "ambiguous_direction" };
  }
  const text = smsToCaptureText(parsed);
  if (!text) return { ok: false, reason: "empty_text" };
  return { ok: true, key: smsKey(msg, parsed), text, parsed };
}

/**
 * From a batch of SMS and the set of keys already captured, decide what to capture.
 * Dedups within the batch too (two SMS with the same reference -> one capture).
 * Returns { toCapture:[{ key, text, parsed, msg }], skipped:{reason:count} }.
 */
export function planCaptures(messages, processed = new Set()) {
  const toCapture = [];
  const skipped = {};
  const seen = new Set();
  for (const msg of messages || []) {
    const res = captureFromSms(msg);
    if (!res.ok) { skipped[res.reason] = (skipped[res.reason] || 0) + 1; continue; }
    if (processed.has(res.key) || seen.has(res.key)) {
      skipped.duplicate = (skipped.duplicate || 0) + 1;
      continue;
    }
    seen.add(res.key);
    toCapture.push({ key: res.key, text: res.text, parsed: res.parsed, msg });
  }
  return { toCapture, skipped };
}
