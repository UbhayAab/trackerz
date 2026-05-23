// Tiny IndexedDB-backed queue so captures don't die if the user is offline,
// the agent is down, or the share-target route fires the SW.
//
// Schema: one object store `captures` with auto-increment key. Each row =
// { id, text, files: [{ name, type, blob }], captureType, queuedAt }.

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
    try {
      const filesAsBlobs = (row.files || []).map((f) => {
        const blob = f.blob instanceof Blob ? f.blob : new Blob([f.blob || ""], { type: f.type });
        return new File([blob], f.name || "blob", { type: f.type || "application/octet-stream" });
      });
      const res = await runCapture({
        text: row.text || "",
        files: filesAsBlobs,
        captureType: row.captureType || "auto",
      });
      results.push({ id: row.id, ok: true, res });
      await removeRow(row.id);
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err.message || String(err) });
    }
  }
  return results;
}

export async function queueSize() {
  const rows = await listOfflineQueue();
  return rows.length;
}
