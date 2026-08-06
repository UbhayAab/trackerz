// Web side of the SMS auto-capture bridge.
//
// Turns the bank/UPI transaction SMS the phone already receives into expenses,
// with no typing. There is no public GPay/UPI transaction API; the bank SMS every
// UPI payment triggers is the only device-side signal, so this reads those SMS
// (via the native SmsReader plugin) and feeds the real ones into the SAME capture
// pipeline as a typed capture (agent-runner.runCapture).
//
// Runs honestly in both worlds, like src/services/health-sync.js:
//   - Plain browser (the Pages PWA): no native bridge. Every function degrades to a
//     clearly-labelled "only in the Android app" result, never pretends to have SMS.
//   - Inside the APK: window.Capacitor.Plugins.SmsReader exists and reads go native.
//
// THE INVARIANTS:
//   - Never double-log a transaction. Idempotency is keyed on the UPI reference /
//     UTR when present (globally unique per payment), else a stable hash of the
//     message. A backfill that re-reads the same SMS, or a live SMS that also lands
//     in the next backfill, is captured exactly once.
//   - Only real money moves. A promo/OTP SMS that is not a debit/credit is dropped.
//   - The parsing is the already-tested deterministic parser (src/imports/sms-parser.js);
//     this module only decides what to feed it and what to skip.

import { runCapture } from "./agent-runner.js";
import { captureFromSms, planCaptures } from "./sms-capture-core.js";

// Pure decision logic (hashString, smsKey, captureFromSms, planCaptures) lives in
// sms-capture-core.js so it stays testable without this module's capture chain.
export { hashString, smsKey, captureFromSms, planCaptures } from "./sms-capture-core.js";

// Shared with notification-capture.js so a payment seen via BOTH a bank SMS and a
// GPay notification (same UPI ref) is captured once, not twice.
const PROCESSED_KEY = "trackerz.spend.processed";   // localStorage: keys already captured
const ENABLED_KEY = "trackerz.sms.autocapture";   // localStorage: user toggle
const PROCESSED_CAP = 1000;                        // keep the most recent N keys

// ---------------------------------------------------------------- bridge detection

/** The native plugin, or null in a browser. Read live - Capacitor may init late. */
function plugin() {
  const cap = globalThis.Capacitor;
  if (!cap) return null;
  if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) return null;
  return cap.Plugins?.SmsReader || null;
}

/** True only inside the Android app with the plugin present. */
export function isNativeSmsAvailable() {
  return plugin() !== null;
}

const BROWSER_MESSAGE =
  "SMS auto-capture is only available in the Deno Android app. A browser cannot " +
  "read SMS, so there is nothing to connect to here.";

function browserFallback(extra = {}) {
  return { supported: false, reason: "no_native_bridge", message: BROWSER_MESSAGE, ...extra };
}

// ---------------------------------------------------------------- processed-key store

function loadProcessed() {
  try {
    const raw = globalThis.localStorage?.getItem(PROCESSED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveProcessed(set) {
  try {
    // Keep only the most recent PROCESSED_CAP keys so the store cannot grow forever.
    const arr = [...set].slice(-PROCESSED_CAP);
    globalThis.localStorage?.setItem(PROCESSED_KEY, JSON.stringify(arr));
  } catch { /* storage full / unavailable - idempotency degrades to the server fingerprint */ }
}

/** Whether the user has switched auto-capture on (default off - opt-in, it reads SMS). */
export function isAutoCaptureEnabled() {
  try { return globalThis.localStorage?.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}

export function setAutoCaptureEnabled(on) {
  try { globalThis.localStorage?.setItem(ENABLED_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- native passthroughs

/** availability() -> { supported, message }. Browser: { supported:false }. */
export async function availability() {
  const p = plugin();
  if (!p) return browserFallback();
  try { return { supported: true, ...(await p.availability()) }; }
  catch (err) { return { supported: true, message: describeError(err), error: true }; }
}

export async function requestPermission() {
  const p = plugin();
  if (!p) return browserFallback({ outcome: "unavailable" });
  try { return { supported: true, ...(await p.requestSmsPermission()) }; }
  catch (err) { return { supported: true, outcome: "unavailable", message: describeError(err), error: true }; }
}

export async function checkPermission() {
  const p = plugin();
  if (!p) return browserFallback({ outcome: "unavailable" });
  try { return { supported: true, ...(await p.checkSmsPermission()) }; }
  catch (err) { return { supported: true, outcome: "unavailable", message: describeError(err), error: true }; }
}

// ---------------------------------------------------------------- capture one SMS

/**
 * Feed one already-decided capture into the pipeline and, only on success, record
 * its key so it is never captured again. Returns true if a capture ran.
 */
async function commitCapture(item, processed) {
  try {
    await runCapture({ text: item.text, captureType: "money" });
    processed.add(item.key);
    return true;
  } catch (err) {
    // A failed capture is NOT marked processed, so the next backfill retries it.
    // eslint-disable-next-line no-console
    console.warn("[sms-capture] capture failed, will retry next backfill:", describeError(err));
    return false;
  }
}

// ---------------------------------------------------------------- backfill

/**
 * Read the recent inbox and capture every new bank/UPI transaction. Idempotent:
 * anything already captured (by reference/hash) is skipped. Safe to call on every
 * app open. Returns { supported, captured, duplicate, skipped, failed, message }.
 */
export async function backfill({ days = 14 } = {}) {
  const p = plugin();
  if (!p) return browserFallback({ captured: 0, duplicate: 0, failed: 0 });

  const perm = await checkPermission();
  if (perm.outcome !== "granted") {
    return { supported: true, captured: 0, duplicate: 0, failed: 0, skipped: {}, message: "SMS permission not granted; nothing read." };
  }

  let read;
  try {
    read = await p.readRecent({ days });
  } catch (err) {
    return { supported: true, captured: 0, duplicate: 0, failed: 1, skipped: {}, message: `Could not read SMS: ${describeError(err)}` };
  }

  const messages = Array.isArray(read?.messages) ? read.messages : [];
  const processed = loadProcessed();
  const { toCapture, skipped } = planCaptures(messages, processed);

  let captured = 0, failed = 0;
  for (const item of toCapture) {
    const ok = await commitCapture(item, processed);
    if (ok) captured++; else failed++;
  }
  if (captured > 0) saveProcessed(processed);

  const duplicate = skipped.duplicate || 0;
  return {
    supported: true,
    captured,
    duplicate,
    failed,
    skipped,
    scanned: messages.length,
    message: `${captured} spend${captured === 1 ? "" : "s"} captured from ${messages.length} SMS` +
      (duplicate ? `, ${duplicate} already logged` : "") + (failed ? `, ${failed} failed` : "") + ".",
  };
}

// ---------------------------------------------------------------- live capture

let liveHandle = null;

/**
 * Start capturing live SMS while the app is open. Idempotent - calling twice does
 * not double-subscribe. Returns a function that stops it.
 */
export async function startAutoCapture() {
  const p = plugin();
  if (!p || liveHandle) return () => {};
  const processed = loadProcessed();
  const handle = await p.addListener("smsReceived", async (msg) => {
    try {
      const res = captureFromSms(msg);
      if (!res.ok || processed.has(res.key)) return;
      const ok = await commitCapture(res, processed);
      if (ok) saveProcessed(processed);
    } catch { /* one bad SMS must not kill the listener */ }
  });
  liveHandle = handle;
  return () => { try { handle.remove(); } catch { /* ignore */ } liveHandle = null; };
}

/**
 * The app-bootstrap entry point. If we are on a device, the user has opted in, and
 * the permission is granted: backfill once and then listen live. No-op everywhere
 * else. Never throws.
 */
export async function initSmsAutoCapture() {
  try {
    if (!isNativeSmsAvailable() || !isAutoCaptureEnabled()) return { started: false, reason: "disabled_or_browser" };
    const perm = await checkPermission();
    if (perm.outcome !== "granted") return { started: false, reason: "no_permission" };
    const result = await backfill({ days: 14 });
    await startAutoCapture();
    return { started: true, backfill: result };
  } catch (err) {
    return { started: false, reason: describeError(err) };
  }
}

// ---------------------------------------------------------------- helpers

function describeError(err) {
  const code = err?.code;
  const msg = err?.message || String(err);
  switch (code) {
    case "permission_denied": return `SMS permission denied: ${msg}`;
    case "read_failed": return `SMS read failed: ${msg}`;
    case "unsupported": return `SMS not supported on this device: ${msg}`;
    default: return msg;
  }
}
