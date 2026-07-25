// DURABLE RETRY FOR PASSIVE SPEND CAPTURE.
//
// The Android listener buffers payment notifications, and the native drain()
// READS AND CLEARS that buffer in one step (PaymentNotificationListenerService).
// So when the upload of a drained payment failed - phone offline, Supabase
// unreachable, agent 500 - the payment was already gone from the device and
// there was nothing left to retry. The code promised "will retry next drain",
// which could not happen: no second copy existed anywhere. Every such payment
// was lost silently.
//
// That is the one failure automatic capture cannot have. If the user is going to
// stop entering spends by hand, a spend that fails to upload has to survive.
//
// Pure: no DOM, no storage, no clock except the `now` you pass in. The storage
// wiring lives in src/services/notification-capture.js.

export const RETRY_CAP = 200;
// A payment that has been failing for two weeks is not going to succeed, and
// keeping it forever means re-attempting it on every app open indefinitely.
export const RETRY_MAX_AGE_MS = 14 * 86400000;

// Drop entries that are too old and cap the list. A message with no usable
// timestamp is KEPT: an unparseable date is not evidence that it is stale, and
// silently discarding a real payment is the bug this module exists to prevent.
export function pruneRetryQueue(list, { now = Date.now(), maxAgeMs = RETRY_MAX_AGE_MS, cap = RETRY_CAP } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoff = nowMs - maxAgeMs;
  const kept = (Array.isArray(list) ? list : []).filter((m) => {
    if (!m || typeof m !== "object") return false;
    const t = m.dateIso ? new Date(m.dateIso).getTime() : NaN;
    if (Number.isNaN(t)) return true;
    return t >= cutoff;
  });
  // Keep the NEWEST when over cap: the oldest are the ones most likely to be
  // permanently unsendable.
  return kept.slice(-cap);
}

// The batch to run through the parser this drain. Carried-over failures go first
// because they are older, and because the device no longer holds a copy of them.
// Deduping is left to planCaptures, which keys on the parsed payment reference -
// so a message that is both carried AND freshly delivered is captured once.
export function mergeForDrain(carried, fresh) {
  return [...(Array.isArray(carried) ? carried : []), ...(Array.isArray(fresh) ? fresh : [])];
}

// The queue to persist after a drain.
//
// `outcomes` is [{ msg, ok }] in the order they were attempted. Only the ORIGINAL
// message is re-queued, never the derived capture text, so a retry runs through
// the same parser and yields the same idempotency key - a retry that later
// succeeds cannot double-book.
//
// This REPLACES the stored queue rather than appending to it: that is what drops
// carried-over entries which finally landed. Appending would make the queue grow
// forever and re-attempt payments that were already booked.
export function nextRetryQueue(outcomes, opts = {}) {
  const failed = [];
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || o.ok) continue;
    if (o.msg) failed.push(o.msg);
  }
  return pruneRetryQueue(failed, opts);
}
