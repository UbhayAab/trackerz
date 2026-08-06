// THE OUTBOX DRAINER.
//
// Was a tiny "if offline, stash it" queue. It is now the single durable path
// every capture takes, because the offline branch was guarding the wrong thing:
// it keyed on `navigator.onLine`, which stays TRUE in a metro tunnel or a
// basement while every request hangs and times out. Those failures fell into the
// `catch`, and `resetForm()` in the `finally` erased the words. The one path that
// reliably destroyed a capture was the one the user hits when they are furthest
// from a keyboard.
//
// State machine: lib/outbox.mjs (pure, fuzz-tested). Storage: outbox-store.js.
// This file is the part that talks to the network.

import { nextState, classifyFailure, backoffMs } from "../../lib/outbox.mjs";
import * as store from "./outbox-store.js";

export { filesOf } from "./outbox-store.js";

// One drain at a time per tab. Two concurrent drains both read the same due list
// and both send it - the classic double-write. Web Locks makes it hold across
// tabs too where available.
let draining = false;
const inFlight = new Set();

export async function enqueueCapture({ text = "", files = [], captureType = "auto" } = {}) {
  const item = await store.enqueue({ text, files, captureType });
  return item.id;
}

export async function listOfflineQueue() {
  return store.all();
}

export async function queueSize() {
  const s = await store.stats();
  return s.depth;
}

export async function outboxStats() {
  return store.stats();
}

/** Call once on boot: anything interrupted mid-flight becomes retryable. */
export async function recoverOutbox() {
  try {
    return await store.recoverInterrupted();
  } catch (err) {
    console.error("[outbox] could not recover interrupted items:", err);
    return 0;
  }
}

/**
 * Remember the server row the moment it exists, so a retry reuses the SAME
 * raw_ingestions row instead of minting a second one. Without this a lost
 * response mints a fresh capture and re-uploads the media under new ids, which
 * changes the capture fingerprint and defeats the server's own dedupe guard -
 * that is how one Rs 80 purchase became Rs 240 in the ledger on 2026-07-09.
 */
async function pinIngestion(item, ingestion) {
  if (!ingestion?.id || item.ingestionId === ingestion.id) return;
  try {
    await store.put({ ...item, ingestionId: ingestion.id });
    item.ingestionId = ingestion.id;
  } catch (err) {
    console.error("[outbox] could not pin ingestion id; a later retry may double-write:", err);
  }
}

/**
 * Attempt every due item once.
 * @param {(input, opts) => Promise<any>} runCapture
 * @returns {Promise<Array>} one result per item attempted
 */
export async function drainOfflineQueue(runCapture, { now = Date.now() } = {}) {
  if (draining) return [];
  draining = true;
  const results = [];
  try {
    const items = await store.due(now);
    for (const raw of items) {
      if (inFlight.has(raw.clientKey)) continue;
      inFlight.add(raw.clientKey);
      let item = nextState(raw, "send", { now: Date.now() });
      await store.put(item);
      try {
        const res = await runCapture(
          {
            text: item.text || "",
            files: store.filesOf(item),
            captureType: item.captureType || "auto",
          },
          {
            ingestionId: item.ingestionId || null,
            onIngestion: (ingestion) => { pinIngestion(item, ingestion); },
          },
        );
        item = nextState({ ...item, ingestionId: item.ingestionId || res?.ingestion?.id || null },
          "ok", { now: Date.now() });
        await store.put(item);
        results.push({ id: item.id, ok: true, res });
      } catch (err) {
        const failure = {
          ...classifyFailure({
            status: err?.status || err?.context?.status || 0,
            body: err?.body || "",
            name: err?.name || "",
          }),
          message: err?.message || String(err),
        };
        item = nextState(item, "error", { now: Date.now(), failure });
        await store.put(item);
        results.push({ id: item.id, ok: false, error: failure.message, kind: failure.kind, state: item.state });
      } finally {
        inFlight.delete(raw.clientKey);
      }
    }
  } catch (err) {
    console.error("[outbox] drain failed:", err);
  } finally {
    draining = false;
  }
  // Something failed but is retryable: come back for it without waiting for the
  // next online event, which may never fire on a connection that never dropped.
  scheduleNextDrain(runCapture);
  return results;
}

let timer = null;
async function scheduleNextDrain(runCapture) {
  if (timer) return;
  let items = [];
  try { items = await store.all(); } catch { return; }
  const waiting = items.filter((i) => i.state === "failed" && i.nextAttemptAt);
  if (!waiting.length) return;
  const soonest = Math.min(...waiting.map((i) => i.nextAttemptAt));
  const delay = Math.max(1000, Math.min(soonest - Date.now(), backoffMs(8, () => 1)));
  timer = setTimeout(() => {
    timer = null;
    drainOfflineQueue(runCapture).catch((err) => console.error("[outbox] scheduled drain failed:", err));
  }, delay);
}

/** Explicit user action: stop retrying this one and stop showing it as pending. */
export async function discardCapture(id) {
  const items = await store.all();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const next = nextState(item, "discard", { now: Date.now() });
  await store.put(next);
  return next;
}

/** Explicit user action: try this one again right now. */
export async function retryNow(id, runCapture) {
  const items = await store.all();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  await store.put({ ...item, state: "failed", nextAttemptAt: Date.now(), attempts: 0 });
  return drainOfflineQueue(runCapture);
}

/** Drop the tombstones. Only ever called for items already dead and seen. */
export async function forget(id) {
  await store.remove(id);
}

/**
 * Mark an item as being attempted right now by the foreground submit path.
 *
 * The interactive submit does NOT go through drainOfflineQueue - it needs the
 * result synchronously so it can render an answer, a spend suggestion or a
 * "didn't understand". But it still writes to the outbox FIRST, so the item is
 * durable before any network call. These two helpers keep that item's state
 * honest while the foreground path owns it.
 */
export async function markSending(id, now = Date.now()) {
  const items = await store.all();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const next = nextState(item, "send", { now });
  await store.put(next);
  return next;
}

/** The capture landed. Drop it - the server row is the record now. */
export async function markSent(id, ingestionId = null) {
  const items = await store.all();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  await store.put(nextState({ ...item, ingestionId }, "ok", { now: Date.now() }));
  // Keep nothing on success: the domain rows are the truth from here, and a
  // lingering "sent" item would show up in the queue depth forever.
  await store.remove(id);
  return null;
}

/** The foreground attempt failed. Hand it back to the retry machine. */
export async function markFailed(id, err) {
  const items = await store.all();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const failure = {
    ...classifyFailure({
      status: err?.status || err?.context?.status || 0,
      body: err?.body || "",
      name: err?.name || "",
    }),
    message: err?.message || String(err),
  };
  const next = nextState(item, "error", { now: Date.now(), failure });
  await store.put(next);
  return next;
}
