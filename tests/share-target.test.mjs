// The Web Share Target was declared but never implemented.
//
// manifest.webmanifest declares share_target with method "POST" and
// enctype "multipart/form-data", so Android POSTs to ./share-target.html when you
// share a payment screenshot or a receipt into Trackerz. sw.js began its fetch
// handler with `if (req.method !== "GET") return;`, so that POST fell through to
// GitHub Pages - a static host, which answers 405. Sharing anything into the app
// was dead, while src/pages/share-target.js was written expecting the service
// worker to have stashed the payload for it.
//
// The SW cannot import src/ modules, so it duplicates the IndexedDB schema. This
// test is what keeps the two copies in agreement: if they drift, a shared file is
// written to a store the page never reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sw = readFileSync("sw.js", "utf8");
// The schema moved to outbox-store.js when the queue became the outbox: every
// capture now goes through it, not just the ones taken while offline.
const queue = readFileSync("src/services/outbox-store.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
const page = readFileSync("src/pages/share-target.js", "utf8");

// --- the manifest still declares what the handler is built for ---------------
const st = manifest.share_target;
assert.ok(st, "manifest declares no share_target");
assert.equal(st.method.toUpperCase(), "POST", "handler assumes a POST share target");
assert.equal(st.enctype, "multipart/form-data");
assert.equal(st.action, "./share-target.html");
assert.equal(st.params.files?.[0]?.name, "media", "the SW reads the file field by the name 'media'");
for (const field of ["title", "text", "url"]) {
  assert.equal(st.params[field], field, `the SW reads form field "${field}"`);
}

// --- the SW actually handles the POST ----------------------------------------
assert.ok(
  /req\.method === "POST"/.test(sw),
  "sw.js does not handle a POST at all - the share target would 405 on a static host"
);
assert.ok(/share-target\.html/.test(sw), "sw.js does not route the share-target path");
assert.ok(/handleShareTarget/.test(sw), "sw.js has no share-target handler");
// The order matters: the POST branch must come BEFORE the GET-only early return,
// or it can never be reached.
assert.ok(
  sw.indexOf('req.method === "POST"') < sw.indexOf('req.method !== "GET"'),
  "the POST branch sits after the GET-only early return, so it is unreachable"
);

// --- the duplicated schema matches the real one ------------------------------
const dbName = queue.match(/const DB_NAME = "([^"]+)"/)?.[1];
const store = queue.match(/const STORE = "([^"]+)"/)?.[1];
assert.ok(dbName && store, "offline-queue.js schema constants not found");
assert.ok(
  sw.includes(`indexedDB.open("${dbName}"`),
  `sw.js opens a different database than offline-queue.js ("${dbName}")`
);
assert.ok(
  sw.includes(`"${store}"`),
  `sw.js writes to a different object store than offline-queue.js ("${store}")`
);
// keyPath "id" with NO autoIncrement: the id is a client-generated UUID that
// doubles as the idempotency key, so a retry reuses it rather than minting a
// second capture. An auto-incremented key cannot do that.
assert.ok(
  /keyPath: "id" \}/.test(sw),
  "sw.js store definition must match outbox-store.js (keyPath id, no autoIncrement)"
);
assert.ok(
  !/autoIncrement:\s*true/.test(sw),
  "an auto-incremented key cannot serve as an idempotency key"
);
const swVersion = sw.match(/indexedDB\.open\("trackerz_offline",\s*(\d+)\)/)?.[1];
const storeVersion = queue.match(/const DB_VERSION = (\d+)/)?.[1];
assert.equal(swVersion, storeVersion,
  `sw.js opens database version ${swVersion} but outbox-store.js declares ${storeVersion} - the lower one triggers an upgrade the other does not expect`);

// The record shape the page and the drainer read back.
for (const field of ["text", "files", "captureType", "ingestionId", "clientKey", "state", "attempts", "createdAt", "nextAttemptAt"]) {
  assert.ok(new RegExp(`\\b${field}\\b`).test(sw), `sw.js record is missing "${field}"`);
}
// A shared file must arrive already retryable, not in some state the drainer
// skips - otherwise sharing into the app queues something that never sends.
assert.ok(/state:\s*"pending"/.test(sw), "a shared capture must be queued as pending");
for (const field of ["name", "type", "blob"]) {
  assert.ok(new RegExp(`${field}:`).test(sw), `sw.js file record is missing "${field}"`);
}

// --- a storage failure must be visible, not silent ---------------------------
assert.ok(/shareerror/.test(sw), "sw.js does not signal a stash failure to the page");
assert.ok(/shareerror/.test(page), "share-target.js does not surface the stash failure");

// --- no pointless confirm tap ------------------------------------------------
// Choosing Trackerz from the share sheet IS the confirmation, and the Home
// additions feed is the undo.
assert.ok(
  !/Ready to process\. Tap below/.test(page),
  "the share page still demands a confirm tap before doing what it was opened to do"
);
assert.ok(/await run\(\)/.test(page), "the share page should process on load");

console.log("share-target.test.mjs OK");
