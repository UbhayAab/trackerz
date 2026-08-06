// GCAL SERVICE - the browser's half of Google Calendar sync.
//
// Everything here is a call to the `gcal` edge function. There is deliberately
// no direct table access and no token handling: the OAuth refresh token lives in
// `calendar_secrets`, whose RLS denies every role a browser can hold, so this
// module could not read one even if it tried. That is the point.
//
// Every function returns a Result from lib/failure.mjs rather than throwing or
// defaulting. The failure mode this whole feature has to survive is not an error
// page - it is an EMPTY CALENDAR that looks completely fine because a refresh
// token quietly expired. A read that returns [] on failure makes that invisible;
// a Result makes the panel able to say what broke, by name.

import { getSupabaseClient } from "./supabase-client.js";
import { Ok, Err, describeError } from "../../lib/failure.mjs";

/**
 * Invoke one gcal action.
 *
 * The edge function answers 200 with `{ ok: false, error }` for expected,
 * nameable states (not_configured, no_account) and a non-2xx for genuine
 * failures. Both come back as an Err with the SERVER'S OWN message, because a
 * message rewritten client-side is a message that can disagree with the truth.
 */
async function invoke(action, body = {}, source = "google calendar") {
  let supabase;
  try {
    supabase = await getSupabaseClient();
  } catch (err) {
    return Err(err, { source, action });
  }
  const { data, error } = await supabase.functions.invoke("gcal", { body: { action, ...body } });
  if (error) {
    // FunctionsHttpError hides the real reason in an unread Response body;
    // describeError() is the one place in this codebase that digs it out.
    return Err(error, { source, action, detail: await describeError(error) });
  }
  if (data && data.ok === false) {
    return Err("server", { message: String(data.error || "unknown") }, { source, action, payload: data });
  }
  return Ok(data || {}, { source, action });
}

/**
 * What the Settings panel renders. Answers even when nothing is configured -
 * "we are missing GOOGLE_CLIENT_ID" IS the status.
 */
export async function fetchGcalStatus() {
  return await invoke("status", {}, "google calendar");
}

/**
 * Start the OAuth flow. `redirect_to` is where Google sends the browser after
 * consent; the server refuses anything not on its allowlist, so a tampered
 * value degrades to the default rather than becoming an open redirect.
 */
export async function startGcalConnect({ scopes = "read_write" } = {}) {
  const redirectTo = typeof location === "undefined" ? "" : location.href.split("?")[0];
  return await invoke("auth_url", { redirect_to: redirectTo, scopes }, "google calendar");
}

/** Pull + push, now, for every connected account. */
export async function syncGcalNow() {
  return await invoke("sync", {}, "google calendar sync");
}

/** Pull only - useful when the user just changed something in Google. */
export async function pullGcalNow() {
  return await invoke("pull", {}, "google calendar pull");
}

/** Push only - useful when the user just changed a reminder here. */
export async function pushGcalNow() {
  return await invoke("push", {}, "google calendar push");
}

/** Revoke at Google and forget the tokens. */
export async function disconnectGcal(accountId) {
  if (!accountId) return Err("schema", new Error("account_id is required"), { source: "google calendar" });
  return await invoke("disconnect", { account_id: accountId }, "google calendar");
}

/**
 * The third-party mirror: other people's meetings, read-only.
 *
 * `tombstoned_at is null` is not optional - a cancelled meeting that still
 * renders is worse than one that never rendered, because the user plans around
 * it. Soft-deleted rows are filtered here rather than by the caller for the same
 * reason every other read in this codebase does it: one place to get right.
 */
export async function fetchMirroredEvents({ fromIso = null, toIso = null, limit = 100 } = {}) {
  let supabase;
  try {
    supabase = await getSupabaseClient();
  } catch (err) {
    return Err(err, { source: "calendar mirror" });
  }
  let query = supabase
    .from("calendar_events_raw")
    .select("id, account_id, calendar_id, event_id, summary, location, organizer_email, starts_at, ends_at, all_day, start_date, html_link, status")
    .is("tombstoned_at", null)
    .order("starts_at", { ascending: true })
    .limit(limit);
  if (fromIso) query = query.gte("starts_at", fromIso);
  if (toIso) query = query.lte("starts_at", toIso);
  const { data, error } = await query;
  if (error) return Err(error, { source: "calendar mirror" });
  return Ok(data || [], { source: "calendar mirror" });
}

/**
 * Is this account's sync broken in a way the user has to act on?
 *
 * Pure, so the panel and any future surface (the morning brief, a push) agree on
 * what "broken" means. `needs_reauth` is separated from a generic failure
 * because the fix is different: one is a button, the other is waiting.
 */
export function gcalHealth(account) {
  const a = account || {};
  if (a.sync_broken_since) {
    const days = Math.floor((Date.now() - Date.parse(a.sync_broken_since)) / 86400000);
    return {
      broken: true,
      needsReauth: a.status === "needs_reauth",
      since: a.sync_broken_since,
      days: Number.isFinite(days) ? days : 0,
      reason: String(a.sync_broken_reason || "no reason recorded"),
    };
  }
  if (a.status === "needs_reauth") {
    return { broken: true, needsReauth: true, since: null, days: 0, reason: "Google needs you to sign in again" };
  }
  return { broken: false, needsReauth: false, since: null, days: 0, reason: "" };
}

/**
 * The channel expiry warning. Google kills watch channels at ~30 days and does
 * NOT renew them; `renew` re-registers daily. This exists so a channel that has
 * already lapsed is VISIBLE rather than showing up as a calendar that mysteriously
 * updates five minutes late forever.
 */
export function gcalChannelState(account) {
  const expiry = account && account.channel_expiry ? Date.parse(account.channel_expiry) : NaN;
  if (!Number.isFinite(expiry)) return { live: false, label: "polling every 5 minutes (no live channel)" };
  const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
  if (daysLeft < 0) return { live: false, label: `live updates lapsed ${Math.abs(daysLeft)}d ago; polling every 5 minutes` };
  return { live: true, label: `live updates on, renews in ${daysLeft}d` };
}

/**
 * The connect banner's message when the OAuth client does not exist yet.
 * Prefers the server's own sentence; the fallback exists only for the case where
 * the function itself is unreachable and cannot speak for itself.
 */
export function gcalSetupMessage(status) {
  const s = status || {};
  if (s.configured) return "";
  if (s.message) return String(s.message);
  const missing = Array.isArray(s.missing_secrets) && s.missing_secrets.length
    ? s.missing_secrets.join(" and ")
    : "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET";
  return `Google Calendar is not connected because ${missing} are not set on this project. See docs/GOOGLE-CALENDAR-SETUP.md.`;
}

/**
 * Read the ?gcal=… parameters the OAuth callback redirects back with, then strip
 * them from the URL so a refresh does not replay the message.
 */
export function readConnectOutcome() {
  if (typeof location === "undefined" || typeof history === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const state = params.get("gcal");
  if (!state) return null;
  const outcome = {
    state,
    account: params.get("account") || "",
    calendar: params.get("calendar") || "",
    note: params.get("note") || "",
    reason: params.get("reason") || "",
  };
  for (const key of ["gcal", "account", "calendar", "note", "reason"]) params.delete(key);
  const rest = params.toString();
  history.replaceState({}, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  return outcome;
}
