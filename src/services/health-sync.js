// Web side of the Health Connect bridge.
//
// This module is the ONLY thing that talks to the native HealthConnect plugin,
// and it is written to be honest in both worlds it runs in:
//
//   - In a plain browser (the GitHub Pages PWA), there is no native bridge. Every
//     function here degrades to a clearly-labelled "only in the Android app"
//     result. It never pretends to have data and never throws just for being in
//     a browser.
//   - Inside the Capacitor APK, window.Capacitor.Plugins.HealthConnect exists and
//     the reads go through to Kotlin.
//
// THE INVARIANT THAT MATTERS MOST: never write a zero. If Health Connect returns
// nothing for a night, no sleep_sessions row is written. If it returns nothing
// for a day, no steps body_metric is written. The bug this project exists to fix
// was "you got zero sleep" appearing from an absent source; this file must not
// be able to recreate it.
//
// UNTESTED ON HARDWARE. The browser degradation path is exercisable and tested
// (see tests/health-sync.test.mjs); the actual native read path has never run on
// a device because nobody building this has one.

import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";

const SOURCE = "healthconnect";

// -------------------------------------------------------------- bridge detection

/**
 * The native plugin, or null in a browser. Read live every time - Capacitor may
 * finish initialising after this module is first imported, so caching a null
 * here would wrongly strand the app in "browser mode".
 */
function plugin() {
  const cap = globalThis.Capacitor;
  if (!cap) return null;
  // isNativePlatform() guards against Capacitor's web shim, which registers a
  // Plugins object but has no real HealthConnect behind it.
  if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) return null;
  const p = cap.Plugins?.HealthConnect;
  return p || null;
}

/** True only inside the Android app with the plugin present. */
export function isNativeHealthAvailable() {
  return plugin() !== null;
}

const BROWSER_MESSAGE =
  "Health sync is only available in the Trackerz Android app. A browser cannot read " +
  "Health Connect, so there is nothing to connect to here.";

/** Shared shape returned whenever we are not on a device. Never looks like data. */
function browserFallback(extra = {}) {
  return { supported: false, reason: "no_native_bridge", message: BROWSER_MESSAGE, ...extra };
}

// -------------------------------------------------------------- native passthroughs

/**
 * availability() -> { supported, state?, message, ... }
 * state is one of: available | not_installed | update_required | unsupported_device.
 * In a browser: { supported:false }. Never throws.
 */
export async function availability() {
  const p = plugin();
  if (!p) return browserFallback({ state: "unsupported_device" });
  try {
    const res = await p.availability();
    return { supported: true, ...res };
  } catch (err) {
    return { supported: true, state: "unsupported_device", message: describeError(err), error: true };
  }
}

/**
 * Ask for Health Connect READ permissions. Returns the plugin's result verbatim
 * (outcome: granted | partial | denied | unavailable) plus supported:true, or a
 * browser fallback. Never throws - the caller renders whatever comes back.
 */
export async function requestPermissions() {
  const p = plugin();
  if (!p) return browserFallback({ outcome: "unavailable" });
  try {
    // Named requestHealthPermissions on the native side to avoid colliding with
    // Capacitor's built-in Plugin.requestPermissions().
    const res = await p.requestHealthPermissions();
    return { supported: true, ...res };
  } catch (err) {
    return { supported: true, outcome: "unavailable", message: describeError(err), error: true };
  }
}

/** Non-interactive permission check, same shape as requestPermissions. */
export async function checkPermissions() {
  const p = plugin();
  if (!p) return browserFallback({ outcome: "unavailable" });
  try {
    const res = await p.checkHealthPermissions();
    return { supported: true, ...res };
  } catch (err) {
    return { supported: true, outcome: "unavailable", message: describeError(err), error: true };
  }
}

// -------------------------------------------------------------- helpers

function requireUserId() {
  const session = getCurrentSession();
  if (!session?.user?.id) throw new Error("not_authenticated");
  return session.user.id;
}

/** Default window: the last N days up to now, as ISO strings. */
export function defaultRange(days = 30) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function describeError(err) {
  // Capacitor rejections carry a `.code` set by the Kotlin call.reject(...).
  const code = err?.code;
  const msg = err?.message || String(err);
  switch (code) {
    case "unavailable":
      return `Health Connect is not available: ${msg}`;
    case "permission_denied":
      return `Permission denied: ${msg}`;
    case "invalid_range":
      return `Bad date range: ${msg}`;
    case "read_failed":
      return `Health Connect read failed: ${msg}`;
    default:
      return msg;
  }
}

// -------------------------------------------------------------- sleep sync

/**
 * Pull sleep sessions from Health Connect and write them into the EXISTING
 * sleep_sessions table with source='healthconnect', so watch-derived nights stay
 * distinguishable from button-entered ones.
 *
 * Idempotent: matches on (user_id, started_at) before inserting, so running it
 * twice over the same window never duplicates a night.
 *
 * Returns { supported, synced, duplicate, failed, skippedInvalid, errors[], message }.
 * NEVER inserts a zero-length or open session - those arrive as droppedInvalid
 * from the plugin and are surfaced, not stored.
 */
export async function syncSleep({ startIso, endIso } = {}) {
  const p = plugin();
  if (!p) return browserFallback({ synced: 0, duplicate: 0, failed: 0 });

  const range = startIso && endIso ? { startIso, endIso } : defaultRange();
  const result = {
    supported: true,
    synced: 0,
    duplicate: 0,
    failed: 0,
    skippedInvalid: 0,
    errors: [],
    message: "",
  };

  let read;
  try {
    read = await p.readSleep(range);
  } catch (err) {
    result.failed = 1;
    result.errors.push(describeError(err));
    result.message = `Could not read sleep: ${describeError(err)}`;
    return result;
  }

  const sessions = Array.isArray(read?.sessions) ? read.sessions : [];
  result.skippedInvalid = Number(read?.droppedInvalid) || 0;

  if (sessions.length === 0) {
    // The honest empty case. No rows, and we say why - not "0 hours".
    result.message =
      result.skippedInvalid > 0
        ? `Health Connect had ${result.skippedInvalid} malformed sleep record(s) and no usable sessions in this window; nothing was written.`
        : "Health Connect returned no sleep for this window. Nothing was written.";
    return result;
  }

  const supabase = await getSupabaseClient();
  const userId = requireUserId();

  for (const s of sessions) {
    // Guard again on the web side: a session with no valid start/end never
    // becomes a row, no matter what the bridge sent.
    const startedAt = normalizeIso(s?.startIso);
    const endedAt = normalizeIso(s?.endIso);
    if (!startedAt || !endedAt || new Date(endedAt) <= new Date(startedAt)) {
      result.skippedInvalid += 1;
      continue;
    }

    try {
      // Idempotency: an existing row at this (user_id, started_at) means this
      // night is already recorded. Match regardless of source so a Health
      // Connect sync does not duplicate a night the user also tapped in.
      const { data: existing, error: selErr } = await supabase
        .from("sleep_sessions")
        .select("id")
        .eq("user_id", userId)
        .eq("started_at", startedAt)
        .limit(1);
      if (selErr) throw selErr;
      if (existing && existing.length > 0) {
        result.duplicate += 1;
        continue;
      }

      const { error: insErr } = await supabase.from("sleep_sessions").insert({
        user_id: userId,
        started_at: startedAt,
        ended_at: endedAt,
        quality: null,
        note: s?.title ? String(s.title).slice(0, 200) : null,
        source: SOURCE,
      });
      if (insErr) throw insErr;
      result.synced += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${startedAt}: ${describeError(err)}`);
    }
  }

  result.message = summarize("sleep session", result);
  return result;
}

// -------------------------------------------------------------- steps sync

/**
 * Pull daily step totals and write them to body_metrics (metric_type 'steps').
 *
 * Idempotent per day: matches on (user_id, metric_type='steps', occurred_at) -
 * occurred_at is normalised to the start of the local day, so re-syncing updates
 * nothing and inserts nothing for a day already present.
 *
 * A zero-step day is NOT written. Health Connect only returns buckets that have
 * data; a genuine zero we cannot distinguish from "phone was at home", so we
 * decline to assert either. Missing steps stay missing.
 *
 * Returns { supported, synced, duplicate, failed, errors[], message }.
 */
export async function syncSteps({ startIso, endIso } = {}) {
  const p = plugin();
  if (!p) return browserFallback({ synced: 0, duplicate: 0, failed: 0 });

  const range = startIso && endIso ? { startIso, endIso } : defaultRange();
  const result = {
    supported: true,
    synced: 0,
    duplicate: 0,
    failed: 0,
    skippedZero: 0,
    errors: [],
    message: "",
  };

  let read;
  try {
    read = await p.readSteps(range);
  } catch (err) {
    result.failed = 1;
    result.errors.push(describeError(err));
    result.message = `Could not read steps: ${describeError(err)}`;
    return result;
  }

  const days = Array.isArray(read?.days) ? read.days : [];
  if (days.length === 0) {
    result.message = "Health Connect returned no step data for this window. Nothing was written.";
    return result;
  }

  const supabase = await getSupabaseClient();
  const userId = requireUserId();

  for (const d of days) {
    const count = Number(d?.count);
    // Never write a zero. A bucket that somehow arrived as 0 is dropped, not
    // stored - a 0-step day is exactly the fabricated-absence bug we refuse to
    // reintroduce.
    if (!Number.isFinite(count) || count <= 0) {
      result.skippedZero += 1;
      continue;
    }
    const occurredAt = dayStartIso(d?.date, d?.startIso);
    if (!occurredAt) {
      result.failed += 1;
      result.errors.push(`unparseable day: ${JSON.stringify(d?.date ?? d?.startIso ?? d)}`);
      continue;
    }

    try {
      const { data: existing, error: selErr } = await supabase
        .from("body_metrics")
        .select("id")
        .eq("user_id", userId)
        .eq("metric_type", "steps")
        .eq("occurred_at", occurredAt)
        .limit(1);
      if (selErr) throw selErr;
      if (existing && existing.length > 0) {
        result.duplicate += 1;
        continue;
      }

      const { error: insErr } = await supabase.from("body_metrics").insert({
        user_id: userId,
        metric_type: "steps",
        value: count,
        unit: "steps",
        occurred_at: occurredAt,
      });
      if (insErr) throw insErr;
      result.synced += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${occurredAt}: ${describeError(err)}`);
    }
  }

  result.message = summarize("step day", result);
  return result;
}

// -------------------------------------------------------------- combined

/**
 * Convenience for the panel: sync sleep + steps in one go, returning both
 * sub-results and a rolled-up count. Never throws for being in a browser.
 */
export async function syncAll({ startIso, endIso } = {}) {
  if (!isNativeHealthAvailable()) return browserFallback({ sleep: null, steps: null });
  const range = startIso && endIso ? { startIso, endIso } : defaultRange();
  const sleep = await syncSleep(range);
  const steps = await syncSteps(range);
  return {
    supported: true,
    at: new Date().toISOString(),
    sleep,
    steps,
    totalSynced: (sleep.synced || 0) + (steps.synced || 0),
  };
}

// -------------------------------------------------------------- small utilities

function normalizeIso(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Collapse a Health Connect day to the start of that LOCAL day as an ISO
 * timestamp - the same key regardless of which hour the sync runs, which is what
 * makes the steps upsert idempotent. Prefers the plugin's own bucket start; falls
 * back to the YYYY-MM-DD date string.
 */
function dayStartIso(dateStr, startIso) {
  if (startIso) {
    const t = Date.parse(startIso);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const local = new Date(`${dateStr}T00:00:00`);
    if (!Number.isNaN(local.getTime())) return local.toISOString();
  }
  return null;
}

function summarize(noun, r) {
  const parts = [];
  parts.push(`${r.synced} ${noun}${r.synced === 1 ? "" : "s"} synced`);
  if (r.duplicate) parts.push(`${r.duplicate} already present`);
  if (r.skippedInvalid) parts.push(`${r.skippedInvalid} invalid skipped`);
  if (r.skippedZero) parts.push(`${r.skippedZero} zero/empty skipped`);
  if (r.failed) parts.push(`${r.failed} failed`);
  return parts.join(", ") + ".";
}
