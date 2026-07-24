// Standalone node:assert test (no runner), matching the repo convention.
// Verifies the device-independent decision logic of SMS auto-capture: which SMS
// become expenses, how they are keyed for idempotency, and that the same
// transaction is never captured twice. The native read + live listener are
// untested-on-hardware (like health-sync); this locks everything below that line.
//
// NOT wired into `npm test` - run on its own: `node tests/sms-capture.test.mjs`.

import assert from "node:assert/strict";
import { captureFromSms, planCaptures, smsKey, hashString } from "../src/services/sms-capture-core.js";

const sms = (body, extra = {}) => ({ address: "VM-HDFCBK", body, dateIso: "2026-07-24T10:00:00.000Z", ...extra });

// --- a real UPI debit becomes an expense capture ---
const debit = captureFromSms(sms("Rs 250.00 debited from a/c XX1234 to SWIGGY via UPI ref 411223344556. Avl bal Rs 5,000"));
assert.equal(debit.ok, true, "a UPI debit is captureworthy");
assert.equal(debit.parsed.direction, "expense");
assert.equal(debit.parsed.amount, 250);
assert.match(debit.text, /Paid Rs 250/i, "capture text is grounded in the SMS");
assert.equal(debit.key, "ref:411223344556", "keyed on the UPI reference when present");

// --- a credit becomes an income capture ---
const credit = captureFromSms(sms("Rs 40,000 credited to a/c XX1234 - SALARY. Avl bal Rs 45,000 ref SAL2026JUL"));
assert.equal(credit.ok, true);
assert.equal(credit.parsed.direction, "income");

// --- non-transaction SMS are dropped, not guessed ---
assert.equal(captureFromSms(sms("Your OTP is 449281. Do not share it with anyone.")).ok, false, "OTP is not a txn");
assert.equal(captureFromSms(sms("Get 10% off your next order! Use code SAVE10")).ok, false, "promo is not a txn");
assert.equal(captureFromSms(sms("")).ok, false, "empty body is not a txn");

// --- ambiguous direction is skipped (a wrong-signed row is worse than a miss) ---
// Both a debit AND a credit word present => the parser cannot sign it => skip.
const ambiguous = captureFromSms(sms("Rs 500 debited from a/c XX1234; if this was not you it will be credited back. bal Rs 2,000"));
assert.equal(ambiguous.ok, false, "un-signable txn => skip");
assert.equal(ambiguous.reason, "ambiguous_direction");

// --- idempotency: the same reference is never captured twice ---
const m1 = sms("Rs 120 debited a/c XX1 to CAFE via UPI ref ABC123XYZ. bal Rs 900");
const m2 = sms("Rs 120 debited a/c XX1 to CAFE via UPI ref ABC123XYZ. bal Rs 900", { id: "different-sms-id" });
const plan = planCaptures([m1, m2]);
assert.equal(plan.toCapture.length, 1, "duplicate reference collapses to one capture");
assert.equal(plan.skipped.duplicate, 1);

// --- already-processed keys are skipped ---
const first = planCaptures([m1]);
const processed = new Set(first.toCapture.map((c) => c.key));
const second = planCaptures([m1], processed);
assert.equal(second.toCapture.length, 0, "an already-captured SMS is not re-captured");

// --- two genuinely different purchases both go through ---
const a = sms("Rs 50 debited a/c XX1 to SHOP_A via UPI ref REF_A. bal Rs 800");
const b = sms("Rs 90 debited a/c XX1 to SHOP_B via UPI ref REF_B. bal Rs 700");
assert.equal(planCaptures([a, b]).toCapture.length, 2, "distinct payments are both captured");

// --- a refless SMS keys on a stable hash, stable across calls ---
const refless = sms("Rs 75 spent on card XX9 at KIRANA. bal Rs 300");
const k1 = captureFromSms(refless).key;
const k2 = captureFromSms(refless).key;
assert.equal(k1, k2, "refless key is stable for the same message");
assert.match(k1, /^h:/, "refless key falls back to a hash");
assert.equal(hashString("abc"), hashString("abc"), "hash is deterministic");
assert.notEqual(hashString("abc"), hashString("abd"), "hash separates different inputs");

console.log("sms-capture tests passed");
