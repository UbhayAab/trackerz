import assert from "node:assert/strict";
import {
  STATES, MAX_ATTEMPTS, MAX_AGE_MS, BASE_DELAY_MS, MAX_DELAY_MS,
  backoffMs, classifyFailure, isDue, nextState, queueStats, invariants, terminalLabel,
} from "../lib/outbox.mjs";

const T0 = 1_754_000_000_000; // fixed clock
const item = (over = {}) => ({
  clientKey: "cap_1", state: "pending", attempts: 0, createdAt: T0, nextAttemptAt: T0,
  text: "6 boiled eggs", ...over,
});

// ---------------------------------------------------------------------------
// Backoff. Full jitter, because a batch queued during one outage would otherwise
// all wake in the same millisecond and hammer a server that is still recovering.
// ---------------------------------------------------------------------------
{
  // Deterministic bounds with the extremes of rand().
  for (let n = 0; n <= 10; n++) {
    const lo = backoffMs(n, () => 0);
    const hi = backoffMs(n, () => 1);
    assert.ok(lo <= hi, `attempt ${n}: low bound <= high bound`);
    assert.ok(hi <= MAX_DELAY_MS, `attempt ${n}: capped at 5 min, got ${hi}`);
    assert.ok(lo >= 1, `attempt ${n}: never zero`);
  }
  assert.equal(backoffMs(0, () => 1), BASE_DELAY_MS);
  // Monotonically non-decreasing until the cap.
  let prev = 0;
  for (let n = 0; n <= 12; n++) {
    const d = backoffMs(n, () => 1);
    assert.ok(d >= prev, "delay never shrinks as attempts rise");
    prev = d;
  }
  // Jitter genuinely spreads: two items retrying at the same attempt count with
  // different random draws must not land on the same instant.
  assert.notEqual(backoffMs(3, () => 0.1), backoffMs(3, () => 0.9));
}

// ---------------------------------------------------------------------------
// Failure classification. Retrying the wrong thing forever is how an outbox
// becomes a battery drain (auth) or a bill (daily cap).
// ---------------------------------------------------------------------------
{
  assert.equal(classifyFailure({ status: 401 }).retry, false, "signed out: stop, ask the user");
  assert.equal(classifyFailure({ status: 403 }).retry, false);
  assert.equal(classifyFailure({ status: 402 }).kind, "cap");
  assert.equal(classifyFailure({ status: 402 }).retry, false, "over the daily AI budget: retrying just burns more");
  assert.equal(classifyFailure({ status: 400 }).retry, false, "a rejected payload will be rejected again");
  assert.equal(classifyFailure({ status: 500 }).retry, true);
  assert.equal(classifyFailure({ status: 503 }).retry, true);
  assert.equal(classifyFailure({ status: 429 }).retry, true);
  assert.ok(classifyFailure({ status: 429 }).minDelayMs >= 30000, "rate limited: back off hard, not 2s");
  assert.equal(classifyFailure({ name: "TimeoutError" }).kind, "timeout");
  assert.equal(classifyFailure({ name: "AbortError" }).retry, true);
  assert.equal(classifyFailure({ status: 0 }).kind, "offline");

  // THE CAPTIVE PORTAL. Hotel and airport wifi answer every request with 200 and
  // an HTML login page. A naive "status === 200" check reads that as success and
  // the capture is silently lost while the UI says saved.
  const portal = classifyFailure({ status: 200, body: "<!DOCTYPE html><html><body>Sign in to WiFi" });
  assert.equal(portal.kind, "captive_portal");
  assert.equal(portal.retry, true);
  assert.ok(portal.minDelayMs >= 30000, "no point retrying a portal every 2 seconds");
}

// ---------------------------------------------------------------------------
// The state machine.
// ---------------------------------------------------------------------------
{
  const a = nextState(item(), "send", { now: T0 });
  assert.equal(a.state, "sending");
  assert.equal(a.attempts, 1);

  const ok = nextState(a, "ok", { now: T0 + 5000 });
  assert.equal(ok.state, "sent");
  assert.equal(ok.lastError, null);

  const failed = nextState(a, "error", { now: T0 + 5000, failure: { kind: "offline", retry: true }, rand: () => 1 });
  assert.equal(failed.state, "failed");
  assert.ok(failed.nextAttemptAt > T0 + 5000, "a failed item waits before its next try");
  assert.equal(failed.lastErrorKind, "offline");

  // Non-retryable dies immediately, at attempt 1, without burning the budget.
  const dead = nextState(a, "error", { now: T0, failure: { kind: "auth", retry: false } });
  assert.equal(dead.state, "dead");
  assert.equal(dead.diedReason, "auth");

  // Exhausting attempts dies.
  const exhausted = nextState(item({ state: "sending", attempts: MAX_ATTEMPTS }), "error",
    { now: T0, failure: { kind: "server", retry: true } });
  assert.equal(exhausted.state, "dead");
  assert.equal(exhausted.diedReason, "max_attempts");

  // Age alone dies, even with attempts left.
  const stale = nextState(item({ state: "sending", attempts: 1, createdAt: T0 - MAX_AGE_MS - 1 }), "error",
    { now: T0, failure: { kind: "server", retry: true } });
  assert.equal(stale.diedReason, "too_old");

  // Purity.
  const before = item();
  const snapshot = JSON.stringify(before);
  nextState(before, "send", { now: T0 });
  assert.equal(JSON.stringify(before), snapshot, "nextState never mutates its input");
}

// ---------------------------------------------------------------------------
// CRASH RECOVERY. A crash is not an event the running code observes, so on boot
// anything left in `sending` was interrupted mid-flight. Without this, a capture
// that was in the air when Android killed the app sits in `sending` forever and
// is never sent and never surfaced - lost, silently, which is the whole failure
// class this outbox exists to end.
// ---------------------------------------------------------------------------
{
  const interrupted = item({ state: "sending", attempts: 1 });
  const recovered = nextState(interrupted, "reload", { now: T0 + 60000 });
  assert.equal(recovered.state, "failed", "an interrupted send becomes retryable");
  assert.ok(isDue(recovered, T0 + 60000), "and is due immediately, not after a backoff nobody saw");

  // Reload must not disturb anything else.
  for (const s of ["pending", "failed", "sent", "dead"]) {
    const it = item({ state: s });
    assert.deepEqual(nextState(it, "reload", { now: T0 }), it, `reload leaves ${s} alone`);
  }
}

// ---------------------------------------------------------------------------
// isDue
// ---------------------------------------------------------------------------
{
  assert.equal(isDue(item(), T0), true);
  assert.equal(isDue(item({ nextAttemptAt: T0 + 1000 }), T0), false);
  assert.equal(isDue(item({ state: "sent" }), T0), false);
  assert.equal(isDue(item({ state: "dead" }), T0), false);
  assert.equal(isDue(item({ state: "sending" }), T0), false, "never double-send an item already in flight");
  assert.equal(isDue(null, T0), false);
}

// ---------------------------------------------------------------------------
// FUZZ: the two invariants that matter. Never lost, never applied twice.
// Seeded so a failure is reproducible.
// ---------------------------------------------------------------------------
{
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= 60; seed++) {
    const rand = mulberry32(seed);
    let items = Array.from({ length: 6 }, (_, i) => item({ clientKey: `cap_${i}`, text: `capture ${i}` }));
    let now = T0;
    const everSent = new Set();

    for (let step = 0; step < 120; step++) {
      now += Math.floor(rand() * 5000);
      const idx = Math.floor(rand() * items.length);
      const it = items[idx];
      const roll = rand();

      let event = "reload";
      if (isDue(it, now)) event = "send";
      else if (it.state === "sending") event = roll < 0.5 ? "ok" : "error";
      else if (roll < 0.04) event = "reload"; // simulate an app restart

      const failure = classifyFailure(
        roll < 0.2 ? { status: 500 } : roll < 0.3 ? { status: 401 } : { status: 0 },
      );
      const before = items[idx].state;
      items[idx] = nextState(it, event, { now, failure, rand });

      // An item may only ever enter `sent` ONCE. Applying a capture twice is the
      // 2026-07-09 incident: one Rs 80 purchase became Rs 240 in the ledger.
      if (items[idx].state === "sent" && before !== "sent") {
        assert.ok(!everSent.has(it.clientKey), `seed ${seed}: ${it.clientKey} reached sent twice`);
        everSent.add(it.clientKey);
        items[idx].ingestionId = `ing_${it.clientKey}`;
      }

      const problems = invariants(items);
      assert.deepEqual(problems, [], `seed ${seed} step ${step}: ${problems.join("; ")}`);

      // NEVER LOST: every key is still present in exactly one item.
      assert.equal(items.length, 6, `seed ${seed}: an item vanished`);
      assert.equal(new Set(items.map((x) => x.clientKey)).size, 6);
      // A dead item is retained, not deleted.
      assert.ok(items.every((x) => STATES.includes(x.state)));
    }
  }
}

// ---------------------------------------------------------------------------
// invariants() catches the things the fuzz is asserting against.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(invariants([]), []);
  assert.ok(invariants([item({ clientKey: "" })]).some((p) => /clientKey/.test(p)));
  assert.ok(invariants([item({ clientKey: "a" }), item({ clientKey: "a" })]).some((p) => /duplicate/.test(p)));
  assert.ok(invariants([item({ state: "sent" })]).some((p) => /ingestionId/.test(p)),
    "a sent item without a server id means we do not actually know it landed");
  assert.ok(invariants([item({ state: "bogus" })]).some((p) => /unknown state/.test(p)));
}

// ---------------------------------------------------------------------------
// Stats for the banner.
// ---------------------------------------------------------------------------
{
  const s = queueStats([
    item({ clientKey: "a", createdAt: T0 - 60000 }),
    item({ clientKey: "b", state: "failed" }),
    item({ clientKey: "c", state: "sent" }),
    item({ clientKey: "d", state: "dead" }),
    item({ clientKey: "e", state: "sending" }),
  ], T0);
  assert.equal(s.depth, 3, "sent is gone, dead is not waiting");
  assert.equal(s.dead, 1);
  assert.equal(s.sending, 1);
  assert.equal(s.oldestMs, 60000);
  assert.equal(queueStats([], T0).depth, 0);
  assert.equal(queueStats([], T0).oldestMs, 0, "no items means no age, not NaN");
}

// ---------------------------------------------------------------------------
// FOUR TERMINAL STATES, always visible. "Processed, zero rows, silence" is what
// made 19 of 89 captures vanish without a signal, which is why the owner
// re-submitted and created duplicates.
// ---------------------------------------------------------------------------
{
  assert.equal(terminalLabel(item({ state: "sent" })).kind, "logged");
  assert.equal(terminalLabel(item({ state: "pending" })).kind, "queued");
  assert.equal(terminalLabel(item({ state: "failed" })).kind, "retrying");
  assert.equal(terminalLabel(item({ state: "sending" })).kind, "sending");
  assert.equal(terminalLabel(item({ state: "dead", diedReason: "auth" })).kind, "needs_attention");
  assert.equal(terminalLabel(item({ state: "dead", diedReason: "discarded" })).kind, "discarded");
  assert.equal(terminalLabel(null), null);
  // Every state maps to something. None may be silent.
  for (const s of STATES) {
    assert.ok(terminalLabel(item({ state: s })), `state ${s} must have a user-visible label`);
  }
}

console.log("outbox tests passed");
