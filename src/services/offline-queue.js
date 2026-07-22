// Tiny IndexedDB-backed queue so captures don't die if the user is offline,
// the agent is down, or the share-target route fires the SW.
//
// Schema: one object store `captures` with auto-increment key. Each row =
// { id, text, files: [{ name, type, blob }], captureType, queuedAt, ingestionId }.
//
// `ingestionId` is remembered the first time a drain reaches the server so the
// next drain retries against the SAME raw_ingestions row. Without it every drain
// minted a fresh capture, which is how one purchase became three ledger rows.

const DB_NAME = "trackerz_offline";
const STORE = "captures";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode) {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function enqueueCapture({ text = "", files = [], captureType = "auto" } = {}) {
  const store = await tx("readwrite");
  const serializedFiles = await Promise.all(
    files.map(async (f) => ({
      name: f.name || "blob",
      type: f.type || "application/octet-stream",
      blob: f instanceof Blob ? f : new Blob([f]),
    })),
  );
  return new Promise((resolve, reject) => {
    const req = store.add({
      text,
      files: serializedFiles,
      captureType,
      queuedAt: Date.now(),
      ingestionId: null,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listOfflineQueue() {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberIngestionId(id, ingestionId) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const get = store.get(id);
    get.onsuccess = () => {
      const row = get.result;
      if (!row) { resolve(null); return; } // already drained; nothing to pin
      const next = { ...row, ingestionId };
      const put = store.put(next);
      put.onsuccess = () => resolve(next);
      put.onerror = () => reject(put.error);
    };
    get.onerror = () => reject(get.error);
  });
}

async function removeRow(id) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function drainOfflineQueue(runCapture) {
  const rows = await listOfflineQueue();
  const results = [];
  for (const row of rows) {
    let res = null;
    try {
      const filesAsBlobs = (row.files || []).map((f) => {
        const blob = f.blob instanceof Blob ? f.blob : new Blob([f.blob || ""], { type: f.type });
        return new File([blob], f.name || "blob", { type: f.type || "application/octet-stream" });
      });
      res = await runCapture(
        {
          text: row.text || "",
          files: filesAsBlobs,
          captureType: row.captureType || "auto",
        },
        {
          // Reuse the ingestion a previous drain already created, and pin the new
          // one the moment it exists so a crash mid-drain still retries into the
          // same capture instead of writing a second one.
          ingestionId: row.ingestionId || null,
          onIngestion: (ingestion) => {
            if (row.ingestionId === ingestion.id) return;
            rememberIngestionId(row.id, ingestion.id).catch((err) => {
              console.error("[offline-queue] could not pin ingestion id; a later retry may double-write:", err);
            });
          },
        },
      );
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err.message || String(err) });
      continue;
    }
    try {
      await removeRow(row.id);
      results.push({ id: row.id, ok: true, res });
    } catch (err) {
      // The capture DID land; only the local cleanup failed. Saying ok:false here
      // would read as "not captured" - say exactly what happened instead.
      results.push({ id: row.id, ok: true, res, cleanupError: err.message || String(err) });
    }
  }
  return results;
}

export async function queueSize() {
  const rows = await listOfflineQueue();
  return rows.length;
}
