// Guards the fix for silently-lost payments.
//
// The Android listener's drain() reads AND clears the native buffer in one step,
// so a payment whose upload then failed was already gone from the device. The
// code claimed it "will retry next drain"; there was no second copy to retry.
import assert from "node:assert/strict";
import {
  pruneRetryQueue, mergeForDrain, nextRetryQueue, RETRY_CAP, RETRY_MAX_AGE_MS,
} from "../lib/capture-retry.mjs";

const NOW = new Date("2026-07-25T13:00:00+05:30");
const ago = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();

const zepto = { body: "You paid Rs 250.00 to Zepto using UPI. UPI Ref 999888777666", dateIso: ago(0), source: "notification", trusted: true };
const eggs  = { body: "You paid Rs 110.00 to Egg Corner using UPI. UPI Ref 123456789012", dateIso: ago(1), source: "notification", trusted: true };

// ---- the core guarantee: a failed payment survives -------------------------
{
  const outcomes = [{ msg: zepto, ok: false }, { msg: eggs, ok: true }];
  const queue = nextRetryQueue(outcomes, { now: NOW });
  assert.equal(queue.length, 1, "only the failure is kept");
  assert.deepEqual(queue[0], zepto, "the ORIGINAL message is re-queued, not the derived text");
}

// ---- the queue REPLACES, so a success drops out of it ----------------------
{
  // Drain 1: zepto fails and is queued.
  const q1 = nextRetryQueue([{ msg: zepto, ok: false }], { now: NOW });
  assert.equal(q1.length, 1);

  // Drain 2: the device buffer is empty; the carried copy is the only one left.
  const batch = mergeForDrain(q1, []);
  assert.equal(batch.length, 1, "the carried payment is what gets retried");
  assert.deepEqual(batch[0], zepto);

  // It succeeds this time.
  const q2 = nextRetryQueue([{ msg: zepto, ok: true }], { now: NOW });
  assert.equal(q2.length, 0, "a payment that finally landed must leave the queue");
}

// A queue that APPENDED instead of replacing would grow forever and re-attempt
// already-booked payments. Assert the replace semantics explicitly.
{
  const q = nextRetryQueue([{ msg: eggs, ok: true }, { msg: zepto, ok: true }], { now: NOW });
  assert.deepEqual(q, [], "all succeeded -> empty queue, not the previous contents");
}

// ---- ordering: carried first, because the device no longer holds them -------
{
  const merged = mergeForDrain([eggs], [zepto]);
  assert.deepEqual(merged, [eggs, zepto], "carried-over failures are attempted first");
  assert.deepEqual(mergeForDrain(null, [zepto]), [zepto], "null carried is not a throw");
  assert.deepEqual(mergeForDrain([eggs], null), [eggs], "null fresh is not a throw");
  assert.deepEqual(mergeForDrain(null, null), []);
}

// ---- staleness -------------------------------------------------------------
{
  const old = { body: "You paid Rs 90.00 to Old Shop. UPI Ref 111", dateIso: ago(20) };
  const recent = { body: "You paid Rs 90.00 to New Shop. UPI Ref 222", dateIso: ago(3) };
  const kept = pruneRetryQueue([old, recent], { now: NOW });
  assert.equal(kept.length, 1, "a payment failing for 20 days is dropped");
  assert.deepEqual(kept[0], recent);

  // Exactly at the boundary it is still kept.
  const boundary = { body: "x", dateIso: new Date(NOW.getTime() - RETRY_MAX_AGE_MS).toISOString() };
  assert.equal(pruneRetryQueue([boundary], { now: NOW }).length, 1, "the cutoff is inclusive");
}

// An unparseable or missing timestamp must NOT be treated as stale. Discarding a
// real payment because its date did not parse is exactly the bug being fixed.
{
  assert.equal(pruneRetryQueue([{ body: "x" }], { now: NOW }).length, 1, "no timestamp -> kept");
  assert.equal(pruneRetryQueue([{ body: "x", dateIso: "not-a-date" }], { now: NOW }).length, 1, "bad timestamp -> kept");
}

// ---- cap keeps the NEWEST ---------------------------------------------------
{
  const many = Array.from({ length: RETRY_CAP + 25 }, (_, i) => ({ body: `pay ${i}`, dateIso: ago(0) }));
  const capped = pruneRetryQueue(many, { now: NOW });
  assert.equal(capped.length, RETRY_CAP);
  assert.equal(capped.at(-1).body, `pay ${RETRY_CAP + 24}`, "the newest are the ones kept");
}

// ---- garbage in ------------------------------------------------------------
assert.deepEqual(nextRetryQueue(null, { now: NOW }), []);
assert.deepEqual(nextRetryQueue([null, undefined, {}], { now: NOW }), [], "an outcome with no msg cannot queue an empty entry");
assert.deepEqual(pruneRetryQueue(null, { now: NOW }), []);
assert.deepEqual(pruneRetryQueue(["nope", 5], { now: NOW }), [], "non-objects are not messages");

console.log("capture-retry.test.mjs OK");
