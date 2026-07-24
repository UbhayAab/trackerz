// Web side of pay-from-app.
//
// Launches a UPI payment from inside Trackerz via the native UpiPay plugin (the
// upi:// deep link that opens GPay/PhonePe prefilled) and records ONLY a confirmed
// payment. The app never moves money or sees bank credentials - it hands off to the
// user's UPI app and reads back the result.
//
// Recording rule, chosen to avoid double-counting with SMS auto-capture:
//   - status "success": log the expense with its txn reference. Cross-source dedupe
//     (src/services/dedupe-scan.js) merges it with the eventual bank SMS row.
//   - anything else (unknown/submitted/failure/cancelled): log NOTHING here. If the
//     payment actually went through, the bank SMS capture will pick it up. An
//     unconfirmed payment must never become a confident ledger row.
//
// Honest in a browser: no bridge -> a clearly-labelled "Android app only" result.
//
// UNTESTED ON HARDWARE. The pure link-building + validation is tested
// (tests/upi-pay.test.mjs); the native launch + result parsing never ran on device.

import { runCapture } from "./agent-runner.js";
import { validatePayInput, buildUpiUri, paymentToCaptureText } from "./upi-pay-core.js";

export { validatePayInput, buildUpiUri, paymentToCaptureText, formatAmount } from "./upi-pay-core.js";

function plugin() {
  const cap = globalThis.Capacitor;
  if (!cap) return null;
  if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) return null;
  return cap.Plugins?.UpiPay || null;
}

export function isNativeUpiAvailable() {
  return plugin() !== null;
}

const BROWSER_MESSAGE =
  "Paying from the app opens your UPI app (GPay/PhonePe) and only works in the " +
  "Trackerz Android app. A browser cannot launch a UPI payment.";

function browserFallback(extra = {}) {
  return { supported: false, reason: "no_native_bridge", message: BROWSER_MESSAGE, ...extra };
}

/** availability() -> { supported, message }. Browser: { supported:false }. */
export async function availability() {
  const p = plugin();
  if (!p) return browserFallback();
  try { return { supported: true, ...(await p.availability()) }; }
  catch (err) { return { supported: true, message: err?.message || String(err), error: true }; }
}

/** A short, UPI-legal reference we generate so the payment can be correlated later. */
function makeRef() {
  // tr must be alphanumeric and short. Date.now is fine here (app runtime, not a
  // workflow script). A trailing random keeps two same-millisecond taps distinct.
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `TZ${Date.now().toString(36)}${rand}`.slice(0, 30).toUpperCase();
}

/**
 * Launch a UPI payment and, only on a confirmed success, log it. Returns
 *   { supported, status, logged, message, ... }.
 * status: success | submitted | unknown | failure | cancelled | invalid | unavailable.
 */
export async function payAndLog({ vpa, name, amount, note } = {}) {
  const valid = validatePayInput({ vpa, amount });
  if (!valid.ok) {
    return { supported: true, status: "invalid", logged: false, reason: valid.reason,
      message: valid.reason === "bad_vpa" ? "Enter a valid UPI ID (name@bank)." : "Enter a valid amount." };
  }
  const p = plugin();
  if (!p) return browserFallback({ status: "unavailable", logged: false });

  const ref = makeRef();
  let res;
  try {
    res = await p.pay({ pa: String(vpa).trim(), pn: name || "", am: String(Number(amount).toFixed(2)),
      tn: note || "", tr: ref });
  } catch (err) {
    const code = err?.code;
    const message = code === "no_upi_app"
      ? "No UPI app is installed to complete the payment."
      : `Could not start the payment: ${err?.message || err}`;
    return { supported: true, status: "failure", logged: false, message, error: true };
  }

  const status = res?.status || "unknown";
  if (status !== "success") {
    return {
      supported: true, status, logged: false, raw: res?.raw || "",
      message: status === "cancelled" ? "Payment cancelled."
        : status === "failure" ? "The UPI app reported the payment failed."
        : "Payment sent. If it went through it will appear from your bank SMS.",
    };
  }

  // Confirmed success: log it once, tagged with the txn reference for dedupe.
  const txnRef = res?.txnRef || ref;
  try {
    await runCapture({ text: paymentToCaptureText({ amount, name, vpa, note, txnRef }), captureType: "money" });
    return { supported: true, status: "success", logged: true, txnRef, message: `Paid Rs ${Number(amount)} and logged.` };
  } catch (err) {
    // Payment succeeded but logging failed - say so honestly; the bank SMS capture
    // is the backstop, so the spend is not lost.
    return { supported: true, status: "success", logged: false, txnRef,
      message: `Payment succeeded but could not be logged (${err?.message || err}); it will appear from your bank SMS.`, error: true };
  }
}
