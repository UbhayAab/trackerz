// IndexedDB half of the outbox. The state machine lives in lib/outbox.mjs (pure,
// fuzz-tested); this file only persists it.
//
// Upgrades the existing `trackerz_offline` database from v1 to v2 IN PLACE and
// MIGRATES any captures already sitting in it. A capture queued before this
// deploy must survive the deploy - dropping the store on upgrade would lose
// exactly the data the outbox exists to protect.

import { nextState, isDue, invariants, queueStats } from "../../lib/outbox.mjs";

const DB_NAME = "trackerz_offline";
const STORE = "captures";
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Private browsing and some locked-down WebViews throw synchronously here.
      dbPromise = null;
      reject(Object.assign(new Error("storage_unavailable"), { cause: err }));
      return;
    }

    // A second tab holding the old version blocks the upgrade forever. The old
    // code had no handler at all, so enqueueCapture simply never settled - the
    // await hung and the capture was neither sent nor visibly queued.
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("idb_blocked: another tab is holding an older version of the database open"));
    };

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("by_state", "state");
        store.createIndex("by_next", "nextAttemptAt");
        return;
      }
      // v1 -> v2. The v1 store used an auto-increment key and had no state,
      // attempts or clientKey. Rewrite each row in place rather than recreating
      // the store, so anything already queued is carried across.
      if (event.oldVersion < 2) {
        const store = tx.objectStore(STORE);
        if (!store.indexNames.contains("by_state")) store.createIndex("by_state", "state");
        if (!store.indexNames.contains("by_next")) store.createIndex("by_next", "nextAttemptAt");
        store.getAll().onsuccess = (e) => {
          const now = Date.now();
          for (const row of e.target.result || []) {
            store.put(migrateV1Row(row, now));
          }
        };
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error || new Error("idb_open_failed")); };
  });
  return dbPromise;
}

function migrateV1Row(row, now) {
  return {
    id: row.id != null ? String(row.id) : newId(),
    clientKey: row.clientKey || `migrated_${row.id}_${row.queuedAt || now}`,
    state: "pending",
    attempts: 0,
    createdAt: row.queuedAt || now,
    nextAttemptAt: now,
    text: row.text || "",
    files: row.files || [],
    captureType: row.captureType || "auto",
    ingestionId: row.ingestionId || null,
    lastError: null,
    lastErrorKind: null,
  };
}

function newId() {
  // crypto.randomUUID is the idempotency key AND the primary key. Minted on the
  // client at enqueue time and stable across every retry - a fresh id per attempt
  // is what let one purchase become three ledger rows.
  return globalThis.crypto?.randomUUID?.()
    || `cap_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (err) { reject(err); return; }
    tx.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("idb_aborted"));
  });
}

/** Put a capture in the outbox. Returns the stored item. Never silently drops. */
export async function enqueue({ text = "", files = [], captureType = "auto" } = {}) {
  const now = Date.now();
  const serialized = await Promise.all(
    files.map(async (f) => ({
      name: f.name || "blob",
      type: f.type || "application/octet-stream",
      blob: f instanceof Blob ? f : new Blob([f]),
    })),
  );
  const id = newId();
  const item = {
    id,
    clientKey: id,
    state: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    text,
    files: serialized,
    captureType,
    ingestionId: null,
    lastError: null,
    lastErrorKind: null,
  };
  await withStore("readwrite", (s) => s.put(item));
  return item;
}

export async function all() {
  return withStore("readonly", (s) => s.getAll());
}

export async function put(item) {
  await withStore("readwrite", (s) => s.put(item));
  return item;
}

export async function remove(id) {
  await withStore("readwrite", (s) => s.delete(id));
}

/**
 * Mark everything interrupted mid-flight as retryable. Call once on boot.
 * A crash is not an event the running code observes, so without this a capture
 * that was in the air when the app was killed sits in `sending` forever.
 */
export async function recoverInterrupted(now = Date.now()) {
  const items = await all();
  const stuck = items.filter((i) => i.state === "sending");
  for (const it of stuck) await put(nextState(it, "reload", { now }));
  return stuck.length;
}

/** Items due to be attempted, oldest first. */
export async function due(now = Date.now()) {
  const items = await all();
  return items.filter((i) => isDue(i, now)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function stats(now = Date.now()) {
  return queueStats(await all(), now);
}

/** Health check for the diagnostics page. [] means healthy. */
export async function health() {
  return invariants(await all());
}

/** Reconstruct real File objects from the stored blobs. */
export function filesOf(item) {
  return (item.files || []).map((f) => {
    const blob = f.blob instanceof Blob ? f.blob : new Blob([f.blob || ""], { type: f.type });
    return new File([blob], f.name || "blob", { type: f.type || "application/octet-stream" });
  });
}
