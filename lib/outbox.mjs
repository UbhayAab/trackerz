// THE OUTBOX STATE MACHINE.
//
// A capture is a durable local object first and a network request second.
//
// The old submit path had exactly one durability branch: `if (!navigator.onLine)`
// enqueue, else fire the request and hope. That is wrong in the case it matters
// most. In a low-signal area - a metro tunnel, a basement car park, a lift -
// `navigator.onLine` stays TRUE, because a radio is attached and an interface is
// up. Every request then hangs, times out, lands in the `catch`, and the old code
// ran `resetForm()` in a `finally`, so the words were simply gone. The only path
// that reliably lost data was the one the user hits when they are furthest from
// a keyboard.
//
// So: every capture is written here BEFORE any network call, and the network is
// a drainer, never a gate. That single inversion is what lets the box clear
// instantly AND guarantees nothing disappears on bad signal, because the text
// does not vanish - it moves into a visible pending row that carries the truth.
//
// Pure: no IndexedDB, no fetch, no clock. `now` is injected. The storage half
// lives in src/services/outbox-store.js so this can be unit-tested in plain Node.

export const STATES = ["pending", "sending", "sent", "failed", "dead"];

// Backoff. Full jitter, per AWS/Stripe: without it, a batch of items queued
// during one outage all wake at the same instant and hammer a server that is
// still recovering.
export const BASE_DELAY_MS = 2000;
export const MAX_DELAY_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
// A dead item is RETAINED, never deleted. The only way to lose a capture is for
// the user to discard it deliberately.
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Delay before attempt N. `rand` is injectable so tests are deterministic.
 * Full jitter: uniform over [half, full] rather than a fixed exponential, so two
 * items queued in the same millisecond do not retry in lockstep forever.
 */
export function backoffMs(attempts, rand = Math.random) {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts));
  return Math.round(exp * (0.5 + rand() * 0.5));
}

/**
 * What KIND of failure was that, and is it worth trying again?
 *
 * Retrying a 401 forever is how an outbox turns into a battery drain, and
 * retrying a 402 is how it turns into a bill. Both are terminal until the user
 * does something. A captive portal is the subtle one: hotel and airport wifi
 * answer every request with 200 and an HTML login page, so a naive "did it
 * return 200" check reads as success and the capture is lost while looking fine.
 */
export function classifyFailure({ status = 0, body = "", name = "" } = {}) {
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", retry: true };
  }
  if (status === 401 || status === 403) return { kind: "auth", retry: false };
  if (status === 402) return { kind: "cap", retry: false };
  if (status === 429) return { kind: "rate_limited", retry: true, minDelayMs: 30000 };
  if (status >= 500) return { kind: "server", retry: true };
  // A 200 carrying HTML is a captive portal, not a success.
  if (status === 200 && /^\s*<(!doctype|html)/i.test(String(body))) {
    return { kind: "captive_portal", retry: true, minDelayMs: 30000 };
  }
  if (status >= 400) return { kind: "rejected", retry: false };
  return { kind: "offline", retry: true };
}

/** Is this item due to be attempted at `now`? */
export function isDue(item, now) {
  if (!item || item.state === "sent" || item.state === "dead") return false;
  if (item.state === "sending") return false;
  return (item.nextAttemptAt || 0) <= now;
}

/**
 * Advance one item. Events: "send" | "ok" | "error" | "reload" | "discard".
 * Returns a NEW item; never mutates.
 *
 * "reload" exists because a crash is not an event the running code gets to
 * observe. On boot, anything left in `sending` was interrupted mid-flight and
 * must become retryable again - otherwise a capture that was in the air when the
 * app was killed sits in `sending` forever and is never sent or surfaced.
 */
export function nextState(item, event, { now = 0, failure = null, rand = Math.random } = {}) {
  const it = { ...item };
  switch (event) {
    case "send":
      return { ...it, state: "sending", attempts: (it.attempts || 0) + 1, lastAttemptAt: now };

    case "ok":
      return { ...it, state: "sent", sentAt: now, lastError: null, lastErrorKind: null };

    case "error": {
      const f = failure || { kind: "offline", retry: true };
      const attempts = it.attempts || 0;
      const tooOld = now - (it.createdAt || now) > MAX_AGE_MS;
      if (!f.retry || attempts >= MAX_ATTEMPTS || tooOld) {
        return {
          ...it,
          state: "dead",
          lastError: f.message || f.kind,
          lastErrorKind: f.kind,
          diedReason: !f.retry ? f.kind : tooOld ? "too_old" : "max_attempts",
        };
      }
      const delay = Math.max(backoffMs(attempts, rand), f.minDelayMs || 0);
      return {
        ...it,
        state: "failed",
        nextAttemptAt: now + delay,
        lastError: f.message || f.kind,
        lastErrorKind: f.kind,
      };
    }

    case "reload":
      // Interrupted mid-flight. Retry promptly rather than waiting out a backoff
      // the user never saw.
      return it.state === "sending" ? { ...it, state: "failed", nextAttemptAt: now } : it;

    case "discard":
      return { ...it, state: "dead", diedReason: "discarded" };

    default:
      return it;
  }
}

/** Counts for the banner: depth, age of the oldest waiting item, dead count. */
export function queueStats(items = [], now = 0) {
  const live = items.filter((i) => i && i.state !== "sent");
  const waiting = live.filter((i) => i.state !== "dead");
  const oldest = waiting.reduce((min, i) => Math.min(min, i.createdAt || now), now);
  return {
    depth: waiting.length,
    dead: live.filter((i) => i.state === "dead").length,
    sending: live.filter((i) => i.state === "sending").length,
    oldestMs: waiting.length ? Math.max(0, now - oldest) : 0,
  };
}

/**
 * Invariants that must hold after every transition. Returns [] when healthy.
 *
 * Exported so the fuzz test can assert them after each step of a random event
 * sequence, and so a diagnostics screen can assert them against real data. The
 * two that matter: a capture is never LOST, and never applied TWICE.
 */
export function invariants(items = []) {
  const problems = [];
  const keys = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object") { problems.push("non-object item"); continue; }
    if (!STATES.includes(it.state)) problems.push(`unknown state: ${it.state}`);
    if (!it.clientKey) problems.push("item without a clientKey");
    if (it.state === "sent" && !it.ingestionId) problems.push(`sent without an ingestionId: ${it.clientKey}`);
    if ((it.attempts || 0) < 0) problems.push(`negative attempts: ${it.clientKey}`);
    const seen = keys.get(it.clientKey) || 0;
    keys.set(it.clientKey, seen + 1);
  }
  for (const [key, n] of keys) if (n > 1) problems.push(`duplicate clientKey: ${key} x${n}`);
  return problems;
}

/**
 * The four states a capture can be in as far as the USER is concerned.
 *
 * "Processed, zero rows, silence" must be impossible: 19 of 89 captures in one
 * audit window ended that way, which is why the owner re-submitted and created
 * duplicates. Every capture ends visibly in exactly one of these.
 */
export function terminalLabel(item) {
  if (!item) return null;
  switch (item.state) {
    case "sent": return { kind: "logged", tone: "ok" };
    case "dead": return item.diedReason === "discarded"
      ? { kind: "discarded", tone: "muted" }
      : { kind: "needs_attention", tone: "error" };
    case "sending": return { kind: "sending", tone: "busy" };
    case "failed": return { kind: "retrying", tone: "warn" };
    default: return { kind: "queued", tone: "muted" };
  }
}
