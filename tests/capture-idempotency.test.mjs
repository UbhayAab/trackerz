// CAPTURE IDEMPOTENCY - the guard against the 2026-07-09 triple-write.
//
// "Just ate 20 rupees lays and 60 for 3 boiled eggs and some riata" was written
// to ledger_entries three times (80, then 20+60, then 20+60) after a transport
// error plus a user re-submit: ~Rs 240 for an Rs 80 purchase.
//
// Two halves are tested here:
//  1. BEHAVIOUR of the capture fingerprint - extracted from the edge function
//     (the writer) and executed, so a drift in the hash inputs fails the build.
//  2. STRUCTURE of the guard - that it runs before the pipeline, keys off a
//     COMPLETED run, is not a unique constraint, and that the client verifies
//     before it claims the agent was unavailable.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
const runner = readFileSync("src/services/agent-runner.js", "utf8");
const queue = readFileSync("src/services/offline-queue.js", "utf8");
const migrationFile = readdirSync("supabase/migrations").find((f) => f.includes("capture_fingerprint"));
assert.ok(migrationFile, "no capture_fingerprint migration found");
const migration = readFileSync(`supabase/migrations/${migrationFile}`, "utf8");

// --- 1. execute the fingerprint block straight out of the edge function -------

const START = "// ==== CAPTURE FINGERPRINT MIRROR START";
const END = "// ==== CAPTURE FINGERPRINT MIRROR END ====";
const from = edge.indexOf(START);
const to = edge.indexOf(END);
assert.ok(from !== -1 && to > from, "capture fingerprint block markers missing from the edge function");
const block = edge.slice(from, to);

// The block is deliberately written with only these annotations so it can be run
// as plain JS here; anything else means the block grew TS the test cannot execute.
const stripped = block.replace(/:\s*(?:string\[\]|string|Promise<string \| null>)/g, "");
assert.ok(!/:\s*[A-Z]/.test(stripped.replace(/\/\/.*$/gm, "")), "unexpected type annotation in the fingerprint block");
const mod = await import(
  `data:text/javascript,${encodeURIComponent(`${stripped}\nexport { normaliseCaptureText, captureFingerprint };`)}`
);
const { captureFingerprint, normaliseCaptureText } = mod;

// The hash must contain NO clock input at all: the same text was submitted at
// 09:03:21 and 09:04:21, so a rounded submit-minute produces two fingerprints.
assert.ok(!/Date|now\(|performance|random/i.test(block), "the fingerprint must not depend on wall-clock time");

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const REAL = "Just ate 20 rupees lays and 60 for 3 boiled eggs and some riata";

const base = await captureFingerprint(USER, REAL, []);
assert.equal(typeof base, "string");
assert.equal(base.length, 64, "expected a sha-256 hex digest");

// Same capture, re-typed by a human on the re-submit: casing, spacing, stray
// punctuation must not defeat the guard.
assert.equal(await captureFingerprint(USER, "  just ate 20 RUPEES lays and 60 for 3 boiled eggs and some riata!! ", []), base);
assert.equal(await captureFingerprint(USER, REAL.replace(/ /g, "\n"), []), base);
// Stable across repeated calls (no hidden state, no clock).
assert.equal(await captureFingerprint(USER, REAL, []), base);

// Different user, same text -> different capture.
assert.notEqual(await captureFingerprint(OTHER, REAL, []), base);
// Genuinely different text -> different capture.
assert.notEqual(await captureFingerprint(USER, "Just ate 20 rupees lays and 60 for 4 boiled eggs", []), base);

// Media asset ids are part of the identity, order- and duplicate-insensitive.
const withMedia = await captureFingerprint(USER, REAL, ["b", "a"]);
assert.equal(await captureFingerprint(USER, REAL, ["a", "b", "a"]), withMedia);
assert.notEqual(withMedia, base, "attaching a photo makes it a different capture");

// Nothing to fingerprint -> null, never a hash of "". Hashing empty would collapse
// every blank capture in the window into one and swallow the second one.
assert.equal(await captureFingerprint(USER, "", []), null);
assert.equal(await captureFingerprint(USER, "   ...  ", []), null);
assert.equal(normaliseCaptureText(null), "");

// --- 2. the guard runs server-side, before anything writes -------------------

const guardAt = edge.indexOf("findPriorCompletedRun(supabase");
const pipelineAt = edge.indexOf("await runPipeline(");
assert.ok(guardAt !== -1, "the edge function does not look up a prior run");
assert.ok(pipelineAt !== -1 && guardAt < pipelineAt, "the idempotency guard must run BEFORE the pipeline - the pipeline is the writer");
assert.match(edge, /\.eq\("status", "completed"\)/, "the guard must key off a COMPLETED run, not any run");
assert.match(edge, /ing\.raw_text \?\? payload\.text/, "the fingerprint must be derived server-side, not taken from the request body");
assert.match(edge, /duplicate: true/, "a replayed run must be labelled as a duplicate, not passed off as a fresh apply");
// A replay must not re-run the pipeline: the short-circuit returns before it.
assert.ok(edge.indexOf("replayRunResult(supabase, prior.id)") < pipelineAt, "a duplicate must return before the pipeline runs");
// A retried invoke of an ingestion that already completed must be a no-op even
// when there is nothing to fingerprint (media-only capture whose upload failed).
assert.match(edge, /const ids = new Set<string>\(\[ingestionId\]\)/, "the current ingestion must always be in the guard's scope");
// A lookup failure must not silently degrade into "no prior run".
assert.match(edge, /capture_guard_unavailable/, "a failed guard lookup must surface, not be swallowed");

// --- 3. the migration must not be a unique constraint -----------------------

assert.match(migration, /add column if not exists capture_fingerprint/);
assert.match(migration, /add column if not exists duplicate_of_ingestion_id/);
assert.ok(
  !/create\s+unique\s+index/i.test(migration),
  "a unique index on the capture shape permanently forbids genuinely repeated identical purchases, and the violation is swallowed into an errored ai_action",
);

// --- 4. the client verifies before claiming the agent was unavailable --------

const pollAt = runner.indexOf("findRunForIngestion(supabase");
const reviewAt = runner.indexOf('tool_name: "request_user_review"');
assert.ok(pollAt !== -1, "the client never polls ai_runs after a failed invoke");
assert.ok(reviewAt !== -1 && pollAt < reviewAt, "the client must poll ai_runs BEFORE writing a request_user_review row");
assert.match(runner, /if \(reviewErr\) throw/, "a failed review-row write must reach the user");
assert.match(runner, /write_confirmed_absent: unverified \? null : true/, "an unverifiable poll must record null, never a confident false/0");
assert.match(runner, /actionCount == null \? "action count unavailable"/, "an unknown action count must not render as 0");
assert.match(runner, /export async function retryCapture/, "no explicit-retry entry point");
assert.match(runner, /ingestionId \? await loadIngestion/, "a retry must reuse the existing raw_ingestions row");

// --- 5. the offline queue retries into the same ingestion -------------------

assert.match(queue, /ingestionId: row\.ingestionId \|\| null/, "a drained capture must retry into the ingestion a previous drain created");
assert.match(queue, /export async function rememberIngestionId/);
assert.match(queue, /cleanupError/, "a capture that landed but failed local cleanup must not be reported as failed");

console.log("capture idempotency tests passed: fingerprint is clock-free and text/media derived; guard precedes the pipeline; no unique constraint; client verifies before claiming failure");
