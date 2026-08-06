import assert from "node:assert/strict";
import {
  SEED_LATENCIES_MS, MIN_SAMPLES, MAX_SAMPLES, MAX_PCT,
  bucketFor, addSample, percentile, progressAt, remainingMs, etaLabel,
} from "../lib/eta.mjs";

const S = SEED_LATENCIES_MS;

// ---------------------------------------------------------------------------
// The measured distribution. These are real numbers from ai_runs.latency_ms and
// the thresholds derived from them are what the UI promises the user, so they
// are pinned here: if the seed changes, this test says so out loud.
// ---------------------------------------------------------------------------
{
  assert.equal(S.length, 18, "18 measured runs");
  assert.equal(Math.min(...S), 5849);
  assert.equal(Math.max(...S), 45665);

  const p50 = percentile(S, 0.5);
  const p90 = percentile(S, 0.9);
  assert.ok(Math.abs(p50 - 12272.5) < 1, `p50 is ~12.3s, got ${p50}`);
  assert.ok(Math.abs(p90 - 27121.1) < 2, `p90 is ~27.1s, got ${p90}`);

  // Interpolated, not nearest-rank. Nearest-rank would make p90 the 17th sample
  // (39.4 s) which would set the "taking longer" threshold 12 s too late.
  assert.ok(p90 < 30000, "p90 is interpolated, not just the 17th sample");
}

// ---------------------------------------------------------------------------
// THE BAR MUST NEVER STALL. This is the whole point: the old bar computed
// Math.min(92, stages.length * 14), hit 92% the moment reasoning began, and sat
// there for the entire model call. The user could not tell a slow agent from a
// dead one.
// ---------------------------------------------------------------------------
{
  // Monotonically non-decreasing across the whole plausible range.
  let prev = -1;
  for (let t = 0; t <= 60000; t += 250) {
    const { pct } = progressAt(S, t);
    assert.ok(pct >= prev, `bar must never go backwards (t=${t}, ${pct} < ${prev})`);
    prev = pct;
  }

  // It genuinely moves through the window where the mass actually is, rather
  // than jumping and freezing.
  const at6 = progressAt(S, 6000).pct;
  const at12 = progressAt(S, 12000).pct;
  const at20 = progressAt(S, 20000).pct;
  assert.ok(at6 < at12 && at12 < at20, `bar advances through 6s->12s->20s (${at6}, ${at12}, ${at20})`);

  // Roughly half the runs are done by the median, which is what "50%" claims.
  assert.ok(at12 >= 40 && at12 <= 60, `at the median the bar is near half, got ${at12}`);

  // Never reaches 100 on its own - only completion does that.
  assert.equal(progressAt(S, 999999).pct, MAX_PCT, "clamped below 100 until actually done");
  assert.ok(progressAt(S, 0).pct >= 1, "never renders an empty bar at t=0");
}

// ---------------------------------------------------------------------------
// Honesty past p90: stop counting down rather than lie.
// ---------------------------------------------------------------------------
{
  assert.equal(progressAt(S, 5000).slow, false);
  assert.equal(progressAt(S, 40000).slow, true, "past p90 the run is flagged slow");
  assert.equal(etaLabel(S, 40000), "taking longer than usual");

  const label = etaLabel(S, 8000);
  assert.match(label, /^about \d+s left$/, `a normal run gets a countdown, got "${label}"`);
  assert.ok(!/-\d/.test(label), "never a negative number");
  assert.ok(!/undefined|NaN/.test(label), "never renders undefined or NaN - the old pill showed ~undefineds");

  // The conditional median GROWS when a run overruns, instead of hitting zero
  // and sitting there.
  const early = remainingMs(S, 6000);
  const late = remainingMs(S, 20000);
  assert.ok(early != null && late != null);
  assert.ok(late > 0 && early > 0);
  assert.equal(remainingMs(S, 999999), null, "slower than every run on record: no estimate to give");
}

// ---------------------------------------------------------------------------
// Too little data must produce NO number rather than a confident one.
// ---------------------------------------------------------------------------
{
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([2400], 0.5), null, "one observation is not a distribution");
  assert.equal(progressAt([2400], 3000).mode, "indeterminate");
  assert.equal(progressAt([2400], 3000).pct, null, "no fabricated percentage");
  assert.equal(etaLabel([2400], 3000), null, "no fabricated countdown");
  assert.equal(progressAt(new Array(MIN_SAMPLES).fill(3000), 1000).mode, "determinate",
    "exactly MIN_SAMPLES is enough");
}

// ---------------------------------------------------------------------------
// Sample hygiene: garbage must not poison the curve for the next 40 captures.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(addSample([], 5000), [5000]);
  assert.deepEqual(addSample([1000], -5), [1000], "a negative duration (clock skew) is rejected");
  assert.deepEqual(addSample([1000], 0), [1000]);
  assert.deepEqual(addSample([1000], NaN), [1000]);
  assert.deepEqual(addSample([1000], 999999999), [1000], "an implausible outlier is rejected");

  let win = [];
  for (let i = 0; i < 100; i++) win = addSample(win, 1000 + i);
  assert.equal(win.length, MAX_SAMPLES, "the window is bounded");
  assert.equal(win[win.length - 1], 1099, "and keeps the most recent");
}

// ---------------------------------------------------------------------------
// Bucketing. A 30 s audio upload and a 2 s text capture must not share a curve.
// ---------------------------------------------------------------------------
{
  assert.equal(bucketFor({ fileCount: 0, kinds: [] }), "text");
  assert.equal(bucketFor({ fileCount: 1, kinds: ["audio"] }), "audio");
  assert.equal(bucketFor({ fileCount: 1, kinds: ["image"] }), "image");
  assert.equal(bucketFor({ fileCount: 2, kinds: ["image", "audio"] }), "mixed");
  assert.equal(bucketFor({ fileCount: 1, kinds: ["file"] }), "file");
  assert.equal(bucketFor(), "text", "no argument is the text case, not a crash");

  // A slow audio curve must not make a text capture look slow.
  const audio = new Array(10).fill(30000);
  assert.ok(progressAt(audio, 12000).pct < progressAt(S, 12000).pct,
    "the same elapsed time reads differently against different distributions");
}

console.log("eta tests passed");
