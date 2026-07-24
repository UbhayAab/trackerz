// Standalone node:assert test (no runner). Locks the device-independent pieces of
// pay-from-app: input validation and the upi:// link it builds. The native launch
// + result parsing are untested-on-hardware (like the other bridges).
//
// NOT wired into `npm test` - run on its own: `node tests/upi-pay.test.mjs`.

import assert from "node:assert/strict";
import { validatePayInput, buildUpiUri, formatAmount, paymentToCaptureText } from "../src/services/upi-pay-core.js";

// --- validation ---
assert.equal(validatePayInput({ vpa: "someone@okhdfc", amount: 250 }).ok, true, "valid VPA + amount");
assert.equal(validatePayInput({ vpa: "not-a-vpa", amount: 250 }).reason, "bad_vpa");
assert.equal(validatePayInput({ vpa: "user@bank", amount: 0 }).reason, "bad_amount");
assert.equal(validatePayInput({ vpa: "user@bank", amount: -5 }).reason, "bad_amount");
assert.equal(validatePayInput({ vpa: "user@bank", amount: 250000 }).reason, "amount_too_large");

// --- amount formatting ---
assert.equal(formatAmount(250), "250.00");
assert.equal(formatAmount(99.5), "99.50");

// --- link building: encoded, correct params, no grouping in amount ---
const uri = buildUpiUri({ vpa: "shop@okaxis", name: "Cafe Coffee", amount: 250, note: "lunch & snacks", ref: "TZABC123" });
assert.ok(uri.startsWith("upi://pay?"), "upi scheme");
const q = new URLSearchParams(uri.slice("upi://pay?".length));
assert.equal(q.get("pa"), "shop@okaxis");
assert.equal(q.get("pn"), "Cafe Coffee");
assert.equal(q.get("am"), "250.00", "amount is a plain 2-decimal string");
assert.equal(q.get("cu"), "INR");
assert.equal(q.get("tn"), "lunch & snacks", "note round-trips through encoding intact");
assert.equal(q.get("tr"), "TZABC123");
// The ampersand in the note must be percent-encoded in the raw string, not a delimiter.
assert.ok(uri.includes("lunch+%26+snacks") || uri.includes("lunch%20%26%20snacks"), "note ampersand is encoded");

// --- optional fields omitted cleanly ---
const bare = new URLSearchParams(buildUpiUri({ vpa: "x@y", amount: 10 }).slice("upi://pay?".length));
assert.equal(bare.get("pn"), null, "no name => no pn param");
assert.equal(bare.get("tn"), null, "no note => no tn param");

// --- confirmed-payment capture text is grounded and carries the ref for dedupe ---
const text = paymentToCaptureText({ amount: 250, name: "Cafe", note: "lunch", txnRef: "T123" });
assert.match(text, /Paid Rs 250 to Cafe for lunch ref T123/);
assert.match(paymentToCaptureText({ amount: 40, vpa: "shop@ok" }), /Paid Rs 40 to shop@ok/, "falls back to VPA when no name");

console.log("upi-pay tests passed");
