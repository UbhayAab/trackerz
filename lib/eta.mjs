// LEARNED PROGRESS + ETA for the capture pipeline.
//
// The agent takes between 5.8 s and 45.7 s. Nielsen's threshold for "the user
// needs a percent-done indicator or they assume it crashed" is 10 s, so this
// pipeline is ALWAYS past that line and a determinate bar is not optional.
//
// But there is no server-side progress to report. The old bar faked it with
// `Math.min(92, stages.length * 14)`, which jumped to 92% the moment reasoning
// started and then sat there for the entire 5-46 s model call. A bar that
// stalls at 92% is worse than no bar: it converts "this is slow" into "this is
// broken".
//
// So the bar is the EMPIRICAL CDF of the user's own past runs: at 50%, half of
// their previous captures of this kind had already finished by now. That is not
// a fiction, it is a posterior. It self-calibrates as the model and the network
// change, it cannot stall at 90% and stay there (the curve is flat only where
// the real distribution is flat), and it decelerates honestly in the tail.
//
// Pure: no DOM, no storage, no clock. Samples and elapsed time are passed in.

// Measured 2026-08-06 from ai_runs.latency_ms, purpose=capture_to_tool_calls,
// deepseek-reasoner, text-only captures. n=18. p50 12.3 s, p90 27.1 s, max 45.7 s.
// Seeded so the very first capture after deploy already has a calibrated curve
// instead of an indeterminate spinner.
export const SEED_LATENCIES_MS = [
  5849, 5849, 5866, 6108, 7134, 7880, 7965, 9304, 11732,
  12813, 14592, 14782, 15640, 17826, 19860, 21866, 39383, 45665,
];

// Rolling window. Big enough to be stable, small enough to forget a model swap.
export const MAX_SAMPLES = 40;
// Below this the distribution is noise; show an indeterminate spinner instead of
// a number. n=1 would render a confident ETA from a single observation.
export const MIN_SAMPLES = 5;
// Never claim 100% before the work is actually done.
export const MAX_PCT = 97;
const MIN_PCT = 3;

// Captures of different shapes have genuinely different distributions - an
// upload and a vision pass are not a text round trip - so they get their own
// curves rather than being averaged into one misleading number.
export function bucketFor({ fileCount = 0, kinds = [] } = {}) {
  if (!fileCount) return "text";
  const set = new Set(kinds);
  if (set.size > 1) return "mixed";
  if (set.has("audio")) return "audio";
  if (set.has("image")) return "image";
  return "file";
}

export function addSample(samples = [], ms) {
  // Reject garbage rather than let a negative clock skew or a stray hour poison
  // the curve for the next 40 captures.
  if (!Number.isFinite(ms) || ms <= 0 || ms > 300000) return samples.slice(-MAX_SAMPLES);
  return [...samples, ms].slice(-MAX_SAMPLES);
}

function sorted(samples) {
  const xs = (samples || []).filter((n) => Number.isFinite(n) && n > 0);
  return xs.length >= MIN_SAMPLES ? [...xs].sort((a, b) => a - b) : null;
}

// Linear-interpolated percentile (R-7, the Excel PERCENTILE.INC convention).
// Nearest-rank would make p90 of an 18-sample set just "the 17th value", which
// is why the raw data looks like it has a 39 s p90 when the interpolated one is
// 27 s.
export function percentile(samples, p) {
  const xs = sorted(samples);
  if (!xs) return null;
  const h = (xs.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return lo === hi ? xs[lo] : xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}

/**
 * Bar position for a run that has been going `elapsedMs`.
 * @returns {{mode:"determinate"|"indeterminate", pct:number|null, slow:boolean}}
 */
export function progressAt(samples, elapsedMs) {
  const xs = sorted(samples);
  if (!xs) return { mode: "indeterminate", pct: null, slow: elapsedMs > 20000 };
  // How many past runs had finished by now.
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= elapsedMs) lo = mid + 1; else hi = mid;
  }
  const pct = Math.max(MIN_PCT, Math.min(MAX_PCT, Math.round((lo / xs.length) * 100)));
  const p90 = percentile(samples, 0.9);
  return { mode: "determinate", pct, slow: p90 != null && elapsedMs > p90 };
}

/**
 * Median remaining time, conditioned on having already lasted `elapsedMs`.
 * Correctly GROWS when a run overruns, which is the honest thing to do - a
 * countdown that hits zero and keeps counting is a lie the user can see.
 * Returns null once the run is slower than every run on record.
 */
export function remainingMs(samples, elapsedMs) {
  const xs = sorted(samples);
  if (!xs) return null;
  const rest = xs.filter((x) => x > elapsedMs);
  if (!rest.length) return null;
  return Math.max(1000, rest[Math.floor(rest.length / 2)] - elapsedMs);
}

/** Short human label: "about 8s left", or the honest admission past p90. */
export function etaLabel(samples, elapsedMs) {
  const { mode, slow } = progressAt(samples, elapsedMs);
  if (slow || mode === "indeterminate") {
    return slow ? "taking longer than usual" : null;
  }
  const rest = remainingMs(samples, elapsedMs);
  if (rest == null) return "taking longer than usual";
  return `about ${Math.max(1, Math.round(rest / 1000))}s left`;
}
