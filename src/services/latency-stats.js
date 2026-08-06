// Persistence for the learned-ETA curves. The maths lives in lib/eta.mjs (pure,
// tested); this is only the localStorage half.
//
// localStorage rather than IndexedDB on purpose: the whole store is a few
// hundred bytes, the render loop wants a synchronous read, and it shares the
// lifecycle of the rest of the app's client state.

import { SEED_LATENCIES_MS, addSample, bucketFor } from "../../lib/eta.mjs";

const KEY = "trackerz.latency.v1";

export { bucketFor };

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    // Seed only the text bucket. The others stay empty until they have real
    // observations, so an audio capture shows an honest spinner rather than a
    // confident number borrowed from a different distribution.
    return { text: SEED_LATENCIES_MS.slice(), ...raw };
  } catch {
    return { text: SEED_LATENCIES_MS.slice() };
  }
}

/** Samples for one bucket, newest last. Never throws. */
export function samplesFor(bucket = "text") {
  const db = load();
  return Array.isArray(db[bucket]) ? db[bucket] : [];
}

/** Record how long a completed capture actually took. Never throws. */
export function recordLatency(bucket, ms) {
  try {
    const db = load();
    db[bucket] = addSample(db[bucket] || [], ms);
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // A full or disabled localStorage must not break capture. The curve simply
    // stops learning, and the seed keeps the bar honest in the meantime.
  }
}
