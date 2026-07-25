// Web side of passive spend capture via payment notifications.
//
// The first-principles answer to "log every rupee with zero change to how I pay":
// the user pays however they already do (Zepto -> GPay, a laptop website, an in-store
// QR, a card swipe), and the payment lands as a NOTIFICATION on this phone. The
// native NotifyReader plugin (backed by PaymentNotificationListenerService) buffers
// the financial ones; this module drains them, parses each with the same
// deterministic parser as SMS, and logs it as an expense. No taps, no review.
//
// Shares the processed-key store and parser with sms-capture.js, so a payment seen
// via BOTH a GPay notification and a bank SMS is logged once.
//
// Honest in a browser: no bridge -> a labelled "Android app only" result.
// UNTESTED ON HARDWARE (the drain/parse decision logic is tested via the shared core).

import { runCapture } from "./agent-runner.js";
import { captureFromSms, planCaptures } from "./sms-capture-core.js";
import { pruneRetryQueue, mergeForDrain, nextRetryQueue } from "../../lib/capture-retry.mjs";

const PROCESSED_KEY = "trackerz.spend.processed"; // SHARED with sms-capture.js
const ENABLED_KEY = "trackerz.notify.autocapture";
const PROCESSED_CAP = 1000;

function plugin() {
  const cap = globalThis.Capacitor;
  if (!cap) return null;
  if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) return null;
  return cap.Plugins?.NotifyReader || null;
}

export function isNativeNotifyAvailable() {
  return plugin() !== null;
}

const BROWSER_MESSAGE =
  "Reading payment notifications is only possible in the Trackerz Android app. A " +
  "browser cannot see your notifications.";

function browserFallback(extra = {}) {
  return { supported: false, reason: "no_native_bridge", message: BROWSER_MESSAGE, ...extra };
}

// -------- processed-key store (shared key with sms-capture) --------

function loadProcessed() {
  try {
    const raw = globalThis.localStorage?.getItem(PROCESSED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveProcessed(set) {
  try {
    globalThis.localStorage?.setItem(PROCESSED_KEY, JSON.stringify([...set].slice(-PROCESSED_CAP)));
  } catch { /* storage unavailable - falls back to the server fingerprint */ }
}

export function isAutoCaptureEnabled() {
  try { return globalThis.localStorage?.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}
export function setAutoCaptureEnabled(on) {
  try { globalThis.localStorage?.setItem(ENABLED_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

// -------- native passthroughs --------

/** Whether the user has granted notification access. Browser: { supported:false }. */
export async function isAccessEnabled() {
  const p = plugin();
  if (!p) return browserFallback({ enabled: false });
  try { return { supported: true, ...(await p.isEnabled()) }; }
  catch (err) { return { supported: true, enabled: false, message: err?.message || String(err), error: true }; }
}

/** Open the system notification-access settings so the user can toggle Trackerz on. */
export async function openAccessSettings() {
  const p = plugin();
  if (!p) return browserFallback();
  try { await p.openSettings(); return { supported: true }; }
  catch (err) { return { supported: true, error: true, message: err?.message || String(err) }; }
}

// -------- drain + capture --------

async function commitCapture(item, processed) {
  try {
    await runCapture({ text: item.text, captureType: "money" });
    processed.add(item.key);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[notification-capture] capture failed, re-queued for the next drain:", err?.message || err);
    return false;
  }
}

// -------- the retry queue --------
//
// The native drain() READS AND CLEARS the buffer in one step
// (PaymentNotificationListenerService.drain). So when a capture failed - phone
// offline, Supabase unreachable, agent 500 - that payment was already gone from
// the device buffer and there was nothing left to retry. The code even promised
// "will retry next drain", which could not happen: there was no next copy of it.
// Every such payment was lost silently, which is the one failure this feature
// cannot have if the user is to stop entering spends by hand.
//
// Failed messages are therefore persisted here and prepended to the next drain.
// Stored as the raw message objects, so they go back through the same parser and
// the same idempotency key - a retry that later succeeds cannot double-book.

// Decision logic is pure and tested in tests/capture-retry.test.mjs; this is
// only the storage wiring.
const RETRY_KEY = "trackerz.spend.retry";

function loadRetry() {
  try {
    const raw = globalThis.localStorage?.getItem(RETRY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return pruneRetryQueue(list);
  } catch { return []; }
}

function saveRetry(list) {
  try {
    globalThis.localStorage?.setItem(RETRY_KEY, JSON.stringify(pruneRetryQueue(list)));
  } catch { /* storage unavailable - the server fingerprint is the backstop */ }
}

/** How many payments are waiting on a retry. Surfaced so a backlog is visible. */
export function pendingRetryCount() {
  return loadRetry().length;
}

/**
 * Drain the buffered payment notifications and log each new one. Idempotent. Safe to
 * call on app open and on resume. Returns { supported, captured, duplicate, failed,
 * skipped, message }.
 */
export async function drainAndCapture() {
  const p = plugin();
  if (!p) return browserFallback({ captured: 0, duplicate: 0, failed: 0 });

  let read;
  try {
    read = await p.drain();
  } catch (err) {
    return { supported: true, captured: 0, duplicate: 0, failed: 1, skipped: {}, message: `Could not read notifications: ${err?.message || err}` };
  }

  const notifications = Array.isArray(read?.notifications) ? read.notifications : [];
  // Shape each native notification into the message the shared parser expects.
  // source "notification" marks it trusted (a payment-app "paid Rs X to Y" needs no
  // banking keyword). The buffered `body` is title + text already joined.
  const fresh = notifications.map((n) => ({
    body: n.body || `${n.title || ""} ${n.text || ""}`.trim(),
    dateIso: n.dateIso,
    source: "notification",
    trusted: n.trusted === true,
    address: n.package || "",
  }));

  // Anything that failed last time goes first: it is older, and the native copy
  // of it no longer exists. planCaptures dedupes within the batch by key, so a
  // retry that also arrived fresh is still captured exactly once.
  const carried = loadRetry();
  const messages = mergeForDrain(carried, fresh);

  const processed = loadProcessed();
  const { toCapture, skipped } = planCaptures(messages, processed);
  let captured = 0, failed = 0;
  const outcomes = [];
  for (const item of toCapture) {
    const ok = await commitCapture(item, processed);
    if (ok) captured++; else failed++;
    // The ORIGINAL message is what gets re-queued, never the derived capture
    // text, so a retry runs through the same parser and yields the same
    // idempotency key - a retry that later succeeds cannot double-book.
    outcomes.push({ msg: item.msg, ok });
  }
  if (captured > 0) saveProcessed(processed);
  // REPLACES the queue rather than appending: that is what drops carried-over
  // entries which finally landed.
  const stillFailing = nextRetryQueue(outcomes);
  saveRetry(stillFailing);

  return {
    supported: true, captured, duplicate: skipped.duplicate || 0, failed, skipped,
    scanned: notifications.length,
    retried: carried.length,
    pendingRetry: stillFailing.length,
    message: `${captured} spend${captured === 1 ? "" : "s"} captured from ${notifications.length} payment notification${notifications.length === 1 ? "" : "s"}` +
      (carried.length ? `, ${carried.length} retried` : "") +
      (failed ? `, ${failed} still pending (will retry)` : "") + ".",
  };
}

/**
 * App-bootstrap entry. If on a device, opted in, and notification access is granted,
 * drain and capture. No-op otherwise. Never throws.
 */
export async function initNotificationCapture() {
  try {
    if (!isNativeNotifyAvailable() || !isAutoCaptureEnabled()) return { started: false, reason: "disabled_or_browser" };
    const acc = await isAccessEnabled();
    if (!acc.enabled) return { started: false, reason: "no_access" };
    const result = await drainAndCapture();
    return { started: true, result };
  } catch (err) {
    return { started: false, reason: err?.message || String(err) };
  }
}

// A pure helper the test can exercise: shape native notifications into parser input.
export function toMessages(notifications) {
  return (notifications || []).map((n) => ({
    body: n.body || `${n.title || ""} ${n.text || ""}`.trim(),
    dateIso: n.dateIso, source: "notification", trusted: n.trusted === true, address: n.package || "",
  }));
}
