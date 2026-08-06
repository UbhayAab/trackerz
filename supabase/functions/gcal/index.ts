// deno-lint-ignore-file no-explicit-any
// GCAL - Google Calendar two-way sync for Deno (the app).
//
// The owner asked for this out loud: "the calendar must connect to my
// Gmail/Google Calendar, and in future mirror any other calendar."
//
// SHAPE OF THE THING
//
//   auth_url  -> the Google consent URL (offline access, prompt=consent)
//   callback  -> code exchange; the refresh token is stored SERVER-SIDE ONLY
//   pull      -> incremental sync with syncToken, showDeleted=true
//   push      -> our reminders out, into a calendar WE created and nothing else
//   webhook   -> events.watch receiver: verify, enqueue, 200, sync out of band
//   drain     -> run what the webhook enqueued (pg_cron, every 5 minutes)
//   renew     -> re-register watch channels before they expire (pg_cron, daily)
//   status    -> exactly what the Settings panel needs to be honest
//   disconnect-> revoke at Google and forget the tokens
//
// THE FIVE THINGS THAT MAKE THIS SAFE
//
// 1. WE ONLY EVER WRITE TO A CALENDAR WE MADE. The grant uses
//    `calendar.app.created`, which is physically incapable of touching the
//    user's real calendars. The worst a bug in push can do is make a mess
//    inside a calendar the user can delete in one tap. Everything we read from
//    their other calendars goes into calendar_events_raw, which nothing writes
//    back.
//
// 2. 410 GONE IS NORMAL CONTROL FLOW. Google expires sync tokens. The
//    documented response is to drop the token and do a full resync, and that is
//    what happens here. Treating it as an error would light the "sync broken"
//    banner on a healthy integration; retrying with the same token loops
//    forever.
//
// 3. A REMOTE DELETE IS ONLY EVER AN EXPLICIT TOMBSTONE (status="cancelled").
//    Never inferred from local absence. A dropped token, a bad time window or a
//    failed request all look like "the event is not here", and a sync that
//    deletes on absence turns any of them into a wiped calendar.
//
// 4. THREE LOOP GUARDS, ALL THREE, DAY ONE. Content hash + ETag echo +
//    X-TRACKERZ-ORIGIN. lib/gcal-sync.mjs has the full argument for why no two
//    of them are enough; tests/gcal-sync.test.mjs runs 100 pull->push->pull
//    iterations that must converge to a noop with exactly one write.
//
// 5. A BROKEN SYNC IS LOUD. Any failure that retrying cannot fix sets
//    calendar_accounts.sync_broken_since + sync_broken_reason, and the Settings
//    panel renders a banner off those two columns. The natural failure mode of
//    this integration is not an error page - it is an empty calendar that looks
//    completely fine, with a missed deadline as the payload.
//
// SECRETS: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, resolved from Deno.env
// first and app_secrets second, exactly like every other key in this codebase.
// Nothing is hardcoded. With them absent every action returns a clean
// `not_configured` with the missing names in it, and the UI says so in words -
// see docs/GOOGLE-CALENDAR-SETUP.md for the click-path that creates them.
//
// Deployed with verify_jwt=false: Google's OAuth redirect and its webhook both
// arrive with no JWT at all. Auth is enforced in-function - a user JWT for the
// user-facing actions, the x-jarvis-secret cron header for drain/renew, and a
// per-channel token for the webhook.

import { createClient } from "npm:@supabase/supabase-js@2.74.0";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CAL_API = "https://www.googleapis.com/calendar/v3";

// The calendar we create and own. Named after the app so it is obvious in the
// Google Calendar sidebar which entries came from here.
const OUR_CALENDAR_SUMMARY = "Deno";

// SCOPES, and why each one is here:
//   calendar.app.created        - create and manage ONLY calendars this app made.
//                                 This is the scope that makes push safe.
//   calendar.events.readonly    - read events on the user's other calendars, for
//                                 the read-only mirror. RESTRICTED by Google:
//                                 an unverified app shows a warning screen the
//                                 owner clicks through. Drop it (pass
//                                 `scopes:["write"]` to auth_url) to connect
//                                 with write-only access.
//   calendar.calendarlist.readonly - list which calendars exist, so a future
//                                 "mirror any other calendar" has something to
//                                 choose from.
//   openid + userinfo.email     - know WHICH account connected. "Connected" that
//                                 cannot name the account is not a fact.
const SCOPE_WRITE = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.app.created",
];
const SCOPE_READ = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

// Where a completed OAuth flow is allowed to send the browser. An open redirect
// on a callback that has just minted a session is a real vulnerability, so the
// list is explicit rather than "any https URL the caller asked for".
const ALLOWED_REDIRECT_PREFIXES = [
  "https://ubhayaab.github.io/trackerz/",
  "http://127.0.0.1:4173/",
  "http://localhost:4173/",
  "https://localhost/",
  "capacitor://localhost/",
];
const DEFAULT_REDIRECT = "https://ubhayaab.github.io/trackerz/pages/settings.html";

// Google expires watch channels at ~30 days and does NOT renew them. Re-register
// anything inside this window; a channel that lapses silently is a calendar that
// stops updating exactly one month after it starts working.
const CHANNEL_TTL_SECONDS = 2592000;         // 30 days, the maximum Google allows
const CHANNEL_RENEW_WITHIN_MS = 3 * 86400000; // re-register with 3 days to spare

// The safety net. A push channel is an optimisation; polling is the thing that
// must never stop, because a channel can die without telling anyone.
const POLL_IF_STALE_MS = 30 * 60000;

// -------- env / clients (mirrors jarvis/index.ts) --------

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function adminClient() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

const _secretCache = new Map<string, string>();
async function resolveSecret(name: string): Promise<string> {
  const fromEnv = Deno.env.get(name);
  if (fromEnv) return fromEnv;
  if (_secretCache.has(name)) return _secretCache.get(name)!;
  const admin = adminClient();
  const { data, error } = await admin.from("app_secrets").select("value").eq("name", name).maybeSingle();
  if (error) throw new Error(`app_secrets read failed for ${name}: ${error.message}`);
  if (!data) throw new Error(`Missing secret ${name} (env + app_secrets both empty)`);
  _secretCache.set(name, data.value);
  return data.value;
}

async function resolveSecretOptional(name: string): Promise<string | null> {
  try {
    return await resolveSecret(name);
  } catch (err) {
    // "not set" is the expected state before the owner creates the OAuth client,
    // and it is NOT the same as "the secrets table is unreachable". Both end up
    // as null here, so the difference is logged rather than swallowed - a config
    // read that fails silently is how a broken deploy reads as an unconfigured
    // one.
    const message = err instanceof Error ? err.message : String(err);
    if (!/^Missing secret /.test(message)) console.error(`resolveSecretOptional(${name}): ${message}`);
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let out = 0;
  for (let i = 0; i < ea.length; i++) out |= ea[i] ^ eb[i];
  return out === 0;
}

// ==== REMINDERS MIRROR START (byte-identical in supabase/functions/jarvis/index.ts) ====
// Plain declarations, exported once at the end - Deno cannot import repo-relative
// lib/, so the jarvis function hosts a copy and tests/mirror-parity.test.mjs proves
// the two never drift. Do not add an import to this block.
const FREQUENCIES = ["once", "daily", "weekly", "monthly", "quarterly", "yearly"];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year, month /* 1-12 */) {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

function parseKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function toKey(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// A date that does not exist lands on the last day of that month rather than
// rolling into the next one. "Rent on the 31st" in February is 28 Feb, not
// 3 March, and a 29 Feb birthday is 28 Feb in a common year. Rolling forward
// would silently move a deadline PAST itself, which for a tax filing is the one
// direction that costs money.
//
// This DIVERGES from RFC 5545, where BYMONTHDAY=31 simply skips February - 11
// fires a year against our 12. lib/rrule-codec.mjs exports the clamp faithfully
// (BYMONTHDAY=28,29,30,31;BYSETPOS=-1) rather than letting an export to Google
// silently drop a deadline; see the round-trip test there.
function clampDay(year, month, day) {
  return Math.min(Math.max(1, day), daysInMonth(year, month));
}

// Day-of-week for a date key. Sakamoto, so it needs no Date object.
const SAKAMOTO = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
function weekdayOf(key) {
  const p = parseKey(key);
  if (!p) return null;
  let { y, m, d } = p;
  if (m < 3) y -= 1;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + SAKAMOTO[m - 1] + d) % 7;
}

function addDays(key, delta) {
  const p = parseKey(key);
  if (!p) return null;
  let { y, m, d } = p;
  d += delta;
  while (d > daysInMonth(y, m)) { d -= daysInMonth(y, m); m += 1; if (m > 12) { m = 1; y += 1; } }
  while (d < 1) { m -= 1; if (m < 1) { m = 12; y -= 1; } d += daysInMonth(y, m); }
  return toKey(y, m, d);
}

function compareKeys(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function daysBetween(from, to) {
  const a = parseKey(from), b = parseKey(to);
  if (!a || !b) return null;
  const toDays = ({ y, m, d }) => {
    let n = d;
    for (let mm = 1; mm < m; mm++) n += daysInMonth(y, mm);
    for (let yy = 1970; yy < y; yy++) n += isLeapYear(yy) ? 366 : 365;
    return n;
  };
  return toDays(b) - toDays(a);
}

// ---- rule parts ------------------------------------------------------------

// "every 2 weeks" starting WHEN? Unanchored, the answer depends on the day you
// happen to ask, which is exactly how a fortnightly reminder drifts a week.
// `dtstart` is the anchor; ruleProblem() below REFUSES a rule that needs one and
// has none rather than returning null forever with nothing said about it.
// `interval` and `count` each have a second spelling because Postgres owns the
// obvious ones: `interval` is a type name and `count` is an aggregate, so the
// columns are rule_interval / max_count (see 20260806000030). Reading both here
// is what lets a DB row be handed to the engine unmapped - and an unmapped row
// is one fewer place for the two to disagree about a date.
function ruleInterval(rule) {
  if (!rule) return 1;
  const n = Number(rule.interval != null ? rule.interval : rule.rule_interval);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function ruleCount(rule) {
  if (!rule) return null;
  const n = Number(rule.count != null ? rule.count : rule.max_count);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// The series anchor: explicit dtstart, else the one-off's own date.
function ruleStart(rule) {
  if (!rule) return null;
  if (parseKey(rule.dtstart)) return String(rule.dtstart);
  if (parseKey(rule.on_date)) return String(rule.on_date);
  return null;
}

// Weekdays as a sorted unique 0-6 list. Accepts the scalar `weekday` (legacy),
// an ARRAY in `weekday`, or the explicit `weekdays`. Before this, a multi-weekday
// rule hit `Number([1,3,5])` -> NaN and silently returned no date at all.
function weekdayList(rule) {
  if (!rule) return [];
  const raw = rule.weekdays != null ? rule.weekdays : rule.weekday;
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    // A null is ABSENT, not Sunday. `Number(null)` is 0, and PostgREST returns
    // null for every unset column - so { freq: "weekly", weekday: null }, the
    // shape of every weekly row read back from the database, read as weekday 0.
    // ruleProblem() then reported no problem, the engine invented a series of
    // Sundays, and describeRule() read the invention back as "every Sunday". An
    // ABSENT key already gave [] because Number(undefined) is NaN; this makes
    // null and absent answer the same, which puts "weekly needs at least one
    // weekday" back on the path it was written for. "" is dropped for the same
    // reason - an empty <input> value is also Number("") === 0.
    if (arr[i] == null || arr[i] === "") continue;
    const n = Number(arr[i]);
    if (Number.isInteger(n) && n >= 0 && n <= 6 && out.indexOf(n) === -1) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

// A list of date keys (exdates / rdates), sorted, deduped, garbage dropped.
function dateList(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const k = String(arr[i] || "");
    if (parseKey(k) && out.indexOf(k) === -1) out.push(k);
  }
  out.sort();
  return out;
}

// Months since year 0, so "every 3 months from May" is one modulo.
function monthIndex(y, m) { return y * 12 + (m - 1); }

// Weeks since the Sunday of 1970-01-04 (1970-01-01 was a Thursday). Sunday-based
// to match weekdayOf, where 0 = Sunday.
function weekIndex(key) {
  const wd = weekdayOf(key);
  if (wd == null) return null;
  const sunday = addDays(key, -wd);
  const d = daysBetween("1970-01-04", sunday);
  return d == null ? null : Math.floor(d / 7);
}

// "the 3rd Tuesday" (nth 1..5) or "the last Friday" (nth -1..-5) of one month.
// Returns null when the month has no such day - a 5th Monday does not exist in
// every month, and inventing one would fire a reminder on the wrong date.
function nthWeekdayOfMonth(y, m, weekday, nth) {
  const dim = daysInMonth(y, m);
  let day;
  if (nth > 0) {
    const firstWd = weekdayOf(toKey(y, m, 1));
    day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7;
  } else {
    const lastWd = weekdayOf(toKey(y, m, dim));
    day = dim - ((lastWd - weekday + 7) % 7) + (nth + 1) * 7;
  }
  if (day < 1 || day > dim) return null;
  return toKey(y, m, day);
}

// Where inside a month this rule lands: an nth-weekday if it has one, otherwise
// the day of the month, clamped.
function dayInMonth(y, m, rule) {
  const nth = Number(rule && rule.nth_weekday);
  if (Number.isInteger(nth) && nth !== 0) {
    const wds = weekdayList(rule);
    if (!wds.length) return null;
    return nthWeekdayOfMonth(y, m, wds[0], nth);
  }
  const day = Number(rule && rule.day_of_month);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return toKey(y, m, clampDay(y, m, day));
}

// "HH:MM" -> minutes past local midnight, or null. Deliberately strict: a time
// we cannot parse must not silently become midnight, which would move an 18:30
// reminder to the top of the day. Seconds are accepted and dropped because a
// Postgres `time` column comes back over PostgREST as "18:30:00".
function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(hhmm == null ? "" : hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

// Minutes past midnight -> "HH:MM". The one display form, so "18:30:00" out of
// Postgres and "18:30" out of an <input type=time> read identically everywhere.
function formatTime(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n) || n < 0) return "";
  return `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(Math.floor(n) % 60).padStart(2, "0")}`;
}

// Why a rule cannot fire, in words, or null when it is fine. Every "returns
// null" path in the engine has a sentence here, because a rule that is stored,
// never fires, and never explains itself is the exact failure this codebase
// keeps rediscovering.
function ruleProblem(rule) {
  rule = rule || {};
  const freq = String(rule.freq || "").toLowerCase();
  if (FREQUENCIES.indexOf(freq) === -1) return `unknown frequency "${rule.freq}"`;

  const interval = ruleInterval(rule);
  const anchor = ruleStart(rule);
  const count = ruleCount(rule);
  if (interval > 1 && !anchor) return "every-N rules need a start date to count from";
  if (count != null && !anchor) return "a count needs a start date to count from";
  if (rule.dtstart != null && rule.dtstart !== "" && !parseKey(rule.dtstart)) return "dtstart must be YYYY-MM-DD";
  if (rule.until != null && rule.until !== "" && !parseKey(rule.until)) return "until must be YYYY-MM-DD";
  if (rule.at_time != null && rule.at_time !== "" && minutesOfDay(rule.at_time) == null) {
    return `"${rule.at_time}" is not a HH:MM time`;
  }

  const nth = Number(rule.nth_weekday);
  const hasNth = Number.isInteger(nth) && nth !== 0;
  if (hasNth && (nth < -5 || nth > 5)) return "nth weekday must be 1..5 or -1..-5";
  if (hasNth && !weekdayList(rule).length) return "an nth-weekday rule needs a weekday";

  if (freq === "once") return parseKey(rule.on_date) ? null : "a one-off needs a date";
  if (freq === "daily") return null;
  if (freq === "weekly") return weekdayList(rule).length ? null : "weekly needs at least one weekday";

  if (!hasNth) {
    const day = Number(rule.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 31) return "needs a day of the month";
  }
  if (freq === "quarterly" || freq === "yearly") {
    const mo = Number(rule.month_of_year);
    const ok = Number.isInteger(mo) && mo >= 1 && mo <= 12;
    if (!ok && !anchor) return "needs an anchor month";
  }
  return null;
}

// The rule's OWN next date on or after `from`, with no exdates, rdates, until or
// count applied. nextOccurrence() layers those on top; splitting them is what
// keeps COUNT countable (it has to enumerate the raw series).
function nextRaw(rule, from) {
  const start = parseKey(from);
  if (!start) return null;
  const freq = String(rule.freq || "").toLowerCase();
  const interval = ruleInterval(rule);
  const anchor = ruleStart(rule);

  if (freq === "once") {
    if (!parseKey(rule.on_date)) return null;
    return compareKeys(rule.on_date, from) >= 0 ? String(rule.on_date) : null;
  }

  if (freq === "daily") {
    if (interval <= 1) return String(from);
    if (!anchor) return null;
    const d = daysBetween(anchor, from);
    if (d == null) return null;
    if (d <= 0) return anchor;
    const rem = d % interval;
    return rem === 0 ? String(from) : addDays(from, interval - rem);
  }

  if (freq === "weekly") {
    const wds = weekdayList(rule);
    if (!wds.length) return null;
    const anchorWeek = anchor ? weekIndex(anchor) : null;
    if (interval > 1 && anchorWeek == null) return null;
    // One full cycle plus a week of slack is always enough to find the next hit.
    const span = 7 * interval + 7;
    for (let i = 0; i < span; i++) {
      const key = addDays(from, i);
      if (!key) return null;
      if (wds.indexOf(weekdayOf(key)) === -1) continue;
      if (interval > 1) {
        const diff = weekIndex(key) - anchorWeek;
        if (diff < 0 || diff % interval !== 0) continue;
      }
      return key;
    }
    return null;
  }

  if (freq === "monthly" || freq === "quarterly" || freq === "yearly") {
    // All three are the same walk: step months at a time from an anchored phase,
    // and place a day inside whichever month qualifies.
    const step = freq === "monthly" ? interval : (freq === "quarterly" ? 3 : 12) * interval;
    // The same refusal daily and weekly already make, which this branch was
    // missing: with no anchor the phase below falls back to the month the CALLER
    // asked from, so "every 2 months" answered Jan/Mar/May when asked in January
    // and Jun/Aug/Oct when asked in June. Same rule, different dates, decided by
    // the day you happened to look - the exact drift the anchor requirement
    // exists to prevent, and ruleProblem() already said it could not fire.
    if (interval > 1 && !anchor) return null;
    const a = anchor ? parseKey(anchor) : null;
    let phaseMonth = Number(rule.month_of_year);
    if (!Number.isInteger(phaseMonth) || phaseMonth < 1 || phaseMonth > 12) {
      if (freq === "monthly") phaseMonth = a ? a.m : start.m;
      else if (a) phaseMonth = a.m;
      else return null;
    }
    // With no dtstart the phase is a bare month-of-year, which is only
    // year-independent while `step` divides 12 - guaranteed here because
    // ruleProblem() rejects interval > 1 without an anchor. Backing the anchor
    // up a year lets a January rule be reachable from the previous December.
    const anchorIdx = monthIndex(a ? a.y : start.y - 1, phaseMonth);
    let idx = monthIndex(start.y, start.m);
    if (idx < anchorIdx) idx = anchorIdx;
    // Jump straight to the next ON-PHASE month, then step whole periods. Walking
    // every month and skipping the off-phase ones spent step-1 iterations out of
    // every step, so the old budget of step*6+24 months was only six periods of
    // real search - and a month that has no such day is skipped, so the search
    // has to be able to run long. "The 5th Tuesday of February" needs a leap
    // February that starts on a Tuesday, which is thirty years out; checked
    // against rrule.js, 58 distinct nth-weekday rules returned null forever
    // instead of their real date. 500 periods is 500 years of a yearly rule and
    // still a bounded loop; the year guard keeps toKey's 4-digit padding honest.
    const off = (idx - anchorIdx) % step;
    if (off !== 0) idx += step - off;
    for (let i = 0; i < 500 && idx < 120000; i++, idx += step) {
      const key = dayInMonth(Math.floor(idx / 12), (idx % 12) + 1, rule);
      if (key && compareKeys(key, from) >= 0) return key;
    }
    return null;
  }

  return null;
}

// Is `key` inside the rule's COUNT window? RFC 5545 sizes the set with COUNT and
// THEN removes EXDATEs, so an excluded date still consumes one of the N - which
// is why this enumerates the RAW series rather than the filtered one.
function withinCount(rule, key) {
  const n = ruleCount(rule);
  if (n == null) return true;
  const anchor = ruleStart(rule);
  if (!anchor) return false;
  let cursor = anchor;
  // The cap has to cover every count the system can STORE, or the series simply
  // stops early and says nothing: reminders.max_count is checked 1..400 in the
  // DB but lib/schedule-args.mjs clamps a scheduled task's count to 500, and at
  // a cap of 400 occurrence 401 of a count-500 rule read as "outside the count"
  // - measured against rrule.js on a plain daily rule.
  const cap = Math.min(n, 500);
  for (let i = 0; i < cap; i++) {
    const cand = nextRaw(rule, cursor);
    if (!cand) return false;
    if (cand === key) return true;
    if (compareKeys(cand, key) > 0) return false;
    cursor = addDays(cand, 1);
    if (!cursor) return false;
  }
  return false;
}

// The next date on or after `from` on which this rule fires. Returns null when
// the rule can never fire again (a `once` that has passed, a series past its
// UNTIL or COUNT) or is unusable - ruleProblem() says which, in words.
//
// `from` is inclusive: a reminder due TODAY is due today, not next year. Getting
// this backwards is how a birthday reminder fires on the 15th.
// `rule` is normalised in the body rather than via a `= {}` default: the edge
// mirror is byte-identical TypeScript, where an empty-object default infers the
// type `{}` and every property read below becomes a compile error.
function nextOccurrence(rule, from) {
  rule = rule || {};
  if (!parseKey(from)) return null;
  // ruleProblem() is the ONE authority on whether a rule can fire, so the engine
  // has to obey it rather than merely report it. Without this a rule it rejects
  // still produced dates - an unparseable `until` was ignored and the series ran
  // forever, a broken dtstart became "no anchor" and an every-N rule invented a
  // phase from the query date. A validator the engine disagrees with is worse
  // than no validator: it tells the user the rule is broken while the server
  // quietly fires it on dates nobody chose.
  if (ruleProblem(rule)) return null;
  const anchor = ruleStart(rule);
  // Nothing fires before the series starts, whatever the caller asked from.
  let cursor = (anchor && compareKeys(anchor, from) > 0) ? anchor : String(from);
  const ex = dateList(rule.exdates);
  const rd = dateList(rule.rdates);
  const until = parseKey(rule.until) ? String(rule.until) : null;

  let base = null;
  for (let i = 0; i < 64; i++) {
    const cand = nextRaw(rule, cursor);
    if (!cand) break;
    if (ex.indexOf(cand) === -1) { base = cand; break; }
    cursor = addDays(cand, 1);
    if (!cursor) break;
  }
  if (base != null && until && compareKeys(base, until) > 0) base = null;
  if (base != null && !withinCount(rule, base)) base = null;

  // RDATEs are ADDED to the set, independent of COUNT and UNTIL - an explicit
  // date is the user saying "and also this one", not part of the pattern.
  let extra = null;
  for (let i = 0; i < rd.length; i++) {
    if (compareKeys(rd[i], from) < 0) continue;
    if (ex.indexOf(rd[i]) !== -1) continue;
    extra = rd[i];
    break;
  }
  if (base == null) return extra;
  if (extra == null) return base;
  return compareKeys(extra, base) < 0 ? extra : base;
}

// Every occurrence in [from, to], capped. Powers the calendar month grid and the
// agenda list (src/ui/calendar-panel.js).
function occurrencesBetween(rule, from, to, cap = 24) {
  rule = rule || {};
  const out = [];
  let cursor = from;
  for (let i = 0; i < cap; i++) {
    const next = nextOccurrence(rule, cursor);
    if (!next || compareKeys(next, to) > 0) break;
    out.push(next);
    cursor = addDays(next, 1);
    if (!cursor) break;
  }
  return out;
}

// The IDENTITY of one firing. The server claims a fire by INSERTing this key
// into reminder_fires, so an on-device scheduler and the edge function must
// derive the same string from the same code - which is the whole reason it lives
// inside the mirror block rather than next to the caller.
//
// The timezone is deliberately NOT part of the key: moving zones does not turn
// "the 10th at 09:00" into a different occurrence, it only moves the instant.
// Without a time this is just the date key, so every row written before at_time
// existed keys exactly as it always did.
function occurrenceKey(rule, dateKey, atTime) {
  if (!parseKey(dateKey)) return null;
  const raw = (atTime != null && atTime !== "") ? atTime : (rule ? rule.at_time : null);
  const mins = minutesOfDay(raw);
  if (mins == null) return String(dateKey);
  return `${dateKey}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// How a rule reads to a human. Shown in the UI and spoken in the brief, so it
// must never say something the rule does not mean.
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// "every 2nd week", "every 3rd month" - the plain-English form of an interval.
function everyN(n, unit) {
  return n <= 1 ? `every ${unit}` : `every ${ordinal(n)} ${unit}`;
}

function hasNthWeekday(rule) {
  const nth = Number(rule && rule.nth_weekday);
  return Number.isInteger(nth) && nth !== 0;
}

// The day-inside-the-month clause, shared by monthly/quarterly/yearly. No
// leading article - the call sites add "the" where their sentence wants one.
function describeDayPart(rule) {
  if (hasNthWeekday(rule)) {
    const nth = Number(rule.nth_weekday);
    const name = WEEKDAYS[weekdayList(rule)[0]] || "day";
    return nth < 0 ? `last ${name}` : `${ordinal(nth)} ${name}`;
  }
  return ordinal(Number(rule.day_of_month));
}

function describeRule(rule) {
  rule = rule || {};
  const freq = String(rule.freq || "").toLowerCase();
  const anchor = Number(rule.month_of_year);
  const n = ruleInterval(rule);
  let base = "";

  if (freq === "once") base = rule.on_date ? `once on ${rule.on_date}` : "once";
  else if (freq === "daily") base = n <= 1 ? "every day" : `every ${n} days`;
  else if (freq === "weekly") {
    const wds = weekdayList(rule);
    const names = wds.map((w) => WEEKDAYS[w]);
    if (!names.length) base = everyN(n, "week");
    else if (n <= 1) base = `every ${names.join(", ")}`;
    else base = `${names.join(", ")}, ${everyN(n, "week")}`;
  } else if (freq === "monthly") {
    base = n <= 1 ? `the ${describeDayPart(rule)} of every month` : `the ${describeDayPart(rule)} of ${everyN(n, "month")}`;
  } else if (freq === "yearly") {
    const mo = MONTHS[anchor - 1] || "";
    const day = hasNthWeekday(rule) ? `${describeDayPart(rule)} of ${mo}` : `${describeDayPart(rule)} ${mo}`;
    base = n <= 1 ? `every ${day}`.trim() : `${day}, ${everyN(n, "year")}`.trim();
  } else if (freq === "quarterly") {
    const step = 3 * n;
    const months = [];
    for (let m = ((anchor - 1) % step) + 1; m <= 12; m += step) months.push(MONTHS[m - 1].slice(0, 3));
    // A named month list is only TRUE while the step divides the year. Every 9
    // months from January is Jan, Oct, Jul, Apr, Jan… - it rotates - so calling
    // it "the 10th of Jan/Oct" names two months that are right the first year
    // and wrong every year after. Say the interval instead when it does not fit.
    base = months.length > 1 && 12 % step === 0
      ? `the ${describeDayPart(rule)} of ${months.join("/")}`
      : `the ${describeDayPart(rule)}, ${everyN(step, "month")}`;
  } else return "";

  // Modifiers, appended in the order a person would say them.
  const at = minutesOfDay(rule.at_time);
  if (at != null) base += ` at ${formatTime(at)}`;
  const count = ruleCount(rule);
  if (count != null) base += `, ${count} time${count === 1 ? "" : "s"}`;
  if (parseKey(rule.until)) base += `, until ${rule.until}`;
  const ex = dateList(rule.exdates);
  if (ex.length) base += `, except ${ex.join(", ")}`;
  const rd = dateList(rule.rdates);
  if (rd.length) base += `, plus ${rd.join(", ")}`;
  return base;
}

// Reminders that should be SAID today: due today, or inside their lead window.
// `lead_days` is how many days of warning a thing needs - a tax filing wants a
// week, a birthday wants a day or two - and 0 means "only on the day".
//
// Each row carries `occurrence_key`, the claim the caller inserts into
// reminder_fires. Computing it here rather than at the call site is what keeps
// the brief, the minute runner and any on-device scheduler agreeing on which
// firing they are talking about.
function dueReminders(reminders, today, { horizon = null } = {}) {
  reminders = reminders || [];
  const out = [];
  for (const r of reminders) {
    if (!r || r.active === false) continue;
    const next = nextOccurrence(r, today);
    if (!next) continue;
    const away = daysBetween(today, next);
    if (away == null) continue;
    const lead = horizon == null ? Math.max(0, Number(r.lead_days) || 0) : horizon;
    if (away > lead) continue;
    out.push({ ...r, next_due_on: next, days_away: away, occurrence_key: occurrenceKey(r, next, null) });
  }
  return out.sort((a, b) => compareKeys(a.next_due_on, b.next_due_on) || String(a.title).localeCompare(String(b.title)));
}

// Reminders whose TIME has arrived today, for the minute-resolution runner.
// `minutesNow` is minutes past local midnight in the reminder's own zone.
//
// A reminder with no at_time is NOT here: it belongs to the 07:00 brief, and
// firing it again at some arbitrary minute would be the same message twice.
// The window is one-sided (fire at or after the time, never before) and the
// caller's reminder_fires claim is what stops a late run from re-firing it.
function timedDue(reminders, today, minutesNow, { graceMinutes = 180 } = {}) {
  reminders = reminders || [];
  const now = Number(minutesNow);
  const out = [];
  if (!Number.isFinite(now)) return out;
  for (const r of reminders) {
    if (!r || r.active === false) continue;
    const at = minutesOfDay(r.at_time);
    if (at == null) continue;
    if (now < at || now - at > graceMinutes) continue;
    const next = nextOccurrence(r, today);
    if (next !== today) continue;
    out.push({ ...r, next_due_on: next, days_away: 0, at_minutes: at, occurrence_key: occurrenceKey(r, next, null) });
  }
  return out.sort((a, b) => a.at_minutes - b.at_minutes || String(a.title).localeCompare(String(b.title)));
}

// The next occurrence of every active reminder, soonest first. Powers the
// "Coming up" list. Unlike dueReminders this ignores lead_days.
function upcoming(reminders, today, { limit = 5, withinDays = 400 } = {}) {
  reminders = reminders || [];
  const out = [];
  for (const r of reminders) {
    if (!r || r.active === false) continue;
    const next = nextOccurrence(r, today);
    if (!next) continue;
    const away = daysBetween(today, next);
    if (away == null || away > withinDays) continue;
    out.push({ ...r, next_due_on: next, days_away: away, occurrence_key: occurrenceKey(r, next, null) });
  }
  out.sort((a, b) => compareKeys(a.next_due_on, b.next_due_on) || String(a.title).localeCompare(String(b.title)));
  return out.slice(0, limit);
}

// Every occurrence of every reminder inside [from, to], flattened into one
// date-keyed map: { "2026-08-14": [reminder, …] }. This is the calendar month
// grid and the agenda in one call - the UI does no date maths of its own.
function agendaBetween(reminders, from, to, { capPerRule = 64 } = {}) {
  reminders = reminders || [];
  const byDay = {};
  for (const r of reminders) {
    if (!r || r.active === false) continue;
    const days = occurrencesBetween(r, from, to, capPerRule);
    for (let i = 0; i < days.length; i++) {
      const k = days[i];
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push({ ...r, next_due_on: k, occurrence_key: occurrenceKey(r, k, null) });
    }
  }
  const keys = Object.keys(byDay).sort();
  for (let i = 0; i < keys.length; i++) {
    byDay[keys[i]].sort((a, b) => {
      const am = minutesOfDay(a.at_time), bm = minutesOfDay(b.at_time);
      if (am != null && bm != null && am !== bm) return am - bm;
      if (am != null && bm == null) return -1;
      if (am == null && bm != null) return 1;
      return String(a.title).localeCompare(String(b.title));
    });
  }
  return byDay;
}

// "today", "tomorrow", "in 3 days", "in 2 weeks" - the phrasing the brief uses.
function whenLabel(daysAway) {
  const n = Number(daysAway);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 14) return `in ${n} days`;
  if (n < 60) return `in ${Math.round(n / 7)} weeks`;
  return `in ${Math.round(n / 30)} months`;
}

// One line per due reminder, for the morning brief and the push body.
function reminderLines(due) {
  due = due || [];
  return due.map((r) => {
    const when = whenLabel(r.days_away);
    const mins = minutesOfDay(r.at_time);
    const at = mins == null ? "" : ` at ${formatTime(mins)}`;
    return `${r.title} ${when === "today" ? "is due today" : `is due ${when}`}${at} (${r.next_due_on}).`;
  });
}
// ==== REMINDERS MIRROR END ====

// ==== RRULE-EXPORT MIRROR START (behaviour-identical to lib/rrule-codec.mjs) ====
// A SELF-CONTAINED copy of our rule parts -> RFC 5545, owned by this function.
// Not byte-mirrored: lib/rrule-codec.mjs is owned elsewhere and is being
// restructured (toRRule now delegates into lib/rrule-engine.mjs), and a
// byte-parity guard against a moving internal fails on refactors that changed
// nothing about the output. tests/gcal-sync.test.mjs EXECUTES this copy and
// lib/rrule-codec.mjs over a corpus and asserts identical output instead - which
// is the guarantee that matters, because a rule exported wrong is a deadline
// that fires on the wrong day.
//
// The clamp divergence lives here: our engine puts "the 31st" on the last day of
// a short month, RFC 5545 SKIPS that month entirely, and exported naively "the
// 31st of every month" becomes 11 fires a year in Google against our 12 - with
// the dropped one being a deadline nobody is told about. BYMONTHDAY=28,29,30,31
// with BYSETPOS=-1 reproduces the clamp exactly.
// RFC weekday codes, index = our weekday number (0 = Sunday).
const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function icalDate(key) {
  return String(key || "").replace(/-/g, "");
}

function fromIcalDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || "").trim());
  if (!m) return null;
  const key = `${m[1]}-${m[2]}-${m[3]}`;
  return parseKey(key) ? key : null;
}

// The BYMONTHDAY clause that reproduces our clamp. See the header.
function clampedMonthDay(day) {
  const d = Math.max(1, Math.min(31, Math.trunc(Number(day) || 1)));
  if (d <= 28) return { byMonthDay: [d], bySetPos: [] };
  const days = [];
  for (let x = 28; x <= d; x++) days.push(x);
  return { byMonthDay: days, bySetPos: [-1] };
}

// ---------------------------------------------------------------------------
// OUR PARTS -> RFC 5545
// ---------------------------------------------------------------------------

/**
 * Serialise one reminder rule to iCalendar.
 *
 * Returns { error } when the rule cannot fire at all (ruleProblem says why) -
 * exporting a rule that does nothing would put a dead entry in someone's real
 * calendar. Otherwise: { dtstart, rrule, exdate, rdate, lines, notes }.
 *
 * DTSTART is mandatory in iCalendar and is also what pins an INTERVAL's phase,
 * so a rule without one gets its first real occurrence on or after `since`.
 */
function toRRule(rule, { since = null } = {}) {
  rule = rule || {};
  const problem = ruleProblem(rule);
  if (problem) return { error: problem };

  const freq = String(rule.freq || "").toLowerCase();
  const n = ruleInterval(rule);
  const notes = [];
  const dtstart = ruleStart(rule) || nextOccurrence(rule, since || todayIshKey());
  if (!dtstart) return { error: "no start date and no future occurrence" };

  const parts = [];
  if (freq === "once") {
    // A one-off is a plain VEVENT with no RRULE. Emitting FREQ=DAILY;COUNT=1
    // would be the same dates and a lie about the user's intent.
    return finish({ dtstart, rrule: "", exdate: [], rdate: [], notes });
  }

  if (freq === "daily") {
    parts.push("FREQ=DAILY");
    if (n > 1) parts.push(`INTERVAL=${n}`);
  } else if (freq === "weekly") {
    parts.push("FREQ=WEEKLY");
    if (n > 1) parts.push(`INTERVAL=${n}`);
    // OUR WEEKS START ON SUNDAY (weekdayOf returns 0 for Sunday, weekIndex counts
    // Sunday-based weeks); RFC 5545's default is WKST=MO. That only matters for
    // INTERVAL>1 weekly rules whose weekday set straddles the week boundary, and
    // there it matters a lot: "every other Sunday and Wednesday" from a Sunday
    // start is 10 dates our way and 9 the RFC-default way, disagreeing from the
    // second date on. WKST is meaningless at INTERVAL=1 (there is no off week to
    // place), so it is stated only where it decides something.
    if (n > 1) parts.push("WKST=SU");
    const wds = weekdayList(rule);
    if (wds.length) parts.push(`BYDAY=${wds.map((w) => ICAL_DAYS[w]).join(",")}`);
  } else if (freq === "monthly" || freq === "quarterly" || freq === "yearly") {
    const nth = Number(rule.nth_weekday);
    const hasNth = Number.isInteger(nth) && nth !== 0;
    const step = freq === "monthly" ? n : (freq === "quarterly" ? 3 : 12) * n;
    const clamp = hasNth ? null : clampedMonthDay(rule.day_of_month);

    // Quarterly and yearly would rather be FREQ=YEARLY;BYMONTH=… so the phase
    // survives a calendar that rewrites DTSTART. But BYSETPOS applies to the
    // whole PERIOD, and a yearly period spanning four months would collapse the
    // clamp set to one date a year. So a clamped quarterly falls back to
    // FREQ=MONTHLY;INTERVAL=3, whose period is a single month.
    const clampNeedsMonthPeriod = Boolean(clamp && clamp.bySetPos.length);
    if (freq === "yearly") {
      parts.push("FREQ=YEARLY");
      if (n > 1) parts.push(`INTERVAL=${n}`);
      const mo = Number(rule.month_of_year) || parseKey(dtstart).m;
      parts.push(`BYMONTH=${mo}`);
    } else if (freq === "quarterly" && !clampNeedsMonthPeriod) {
      parts.push("FREQ=YEARLY");
      const anchor = Number(rule.month_of_year) || parseKey(dtstart).m;
      const months = [];
      for (let m = ((anchor - 1) % step) + 1; m <= 12; m += step) months.push(m);
      parts.push(`BYMONTH=${months.join(",")}`);
    } else {
      parts.push("FREQ=MONTHLY");
      if (step > 1) parts.push(`INTERVAL=${step}`);
      if (freq !== "monthly") {
        notes.push("phase is carried by DTSTART - a calendar that rewrites DTSTART will shift this rule");
      }
    }

    if (hasNth) {
      const wd = weekdayList(rule)[0];
      // The sign is written explicitly. "+3TU" and "3TU" are the same rule to the
      // RFC, but the explicit form is what lib/rrule-codec.mjs emits and what
      // parsers round-trip unchanged.
      parts.push(`BYDAY=${nth > 0 ? "+" : ""}${nth}${ICAL_DAYS[wd]}`);
    } else {
      parts.push(`BYMONTHDAY=${clamp.byMonthDay.join(",")}`);
      if (clamp.bySetPos.length) {
        parts.push(`BYSETPOS=${clamp.bySetPos.join(",")}`);
        notes.push(`day ${rule.day_of_month} is CLAMPED to the month end here; plain BYMONTHDAY=${rule.day_of_month} would skip short months entirely`);
      }
    }
  } else {
    return { error: `cannot express freq "${rule.freq}"` };
  }

  const count = Number(rule.count);
  if (Number.isInteger(count) && count >= 1) parts.push(`COUNT=${count}`);
  else if (parseKey(rule.until)) parts.push(`UNTIL=${icalDate(rule.until)}`);

  return finish({
    dtstart,
    rrule: parts.join(";"),
    exdate: dateList(rule.exdates),
    rdate: dateList(rule.rdates),
    notes,
  });
}

function finish(o) {
  const lines = [`DTSTART;VALUE=DATE:${icalDate(o.dtstart)}`];
  if (o.rrule) lines.push(`RRULE:${o.rrule}`);
  if (o.exdate.length) lines.push(`EXDATE;VALUE=DATE:${o.exdate.map(icalDate).join(",")}`);
  if (o.rdate.length) lines.push(`RDATE;VALUE=DATE:${o.rdate.map(icalDate).join(",")}`);
  return { ...o, lines };
}

// A rule with no dtstart still has to start somewhere for export purposes. This
// is the ONE clock read in the file, isolated so every other function stays pure.
function todayIshKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// ==== RRULE-EXPORT MIRROR END ====

// ==== GCAL-SYNC MIRROR START (byte-identical in supabase/functions/gcal/index.ts) ====
// Plain declarations, exported once at the end - Deno cannot import repo-relative
// lib/, so the gcal function hosts a copy and tests/gcal-sync.test.mjs proves the
// two never drift. Do not add an import to this block. Every name is `gc`-prefixed
// because the edge function also carries the reminders mirror, which owns the
// unprefixed spellings of addDays/parseKey/minutesOfDay.

// The extended properties we stamp on every event we create. `private` scope, so
// they are visible only to this OAuth client - the user does not see them in the
// Google Calendar UI and another app cannot read them.
const GC_ORIGIN_KEY = "X-TRACKERZ-ORIGIN";
const GC_ORIGIN_VALUE = "trackerz";
const GC_HASH_KEY = "X-TRACKERZ-HASH";
const GC_REMINDER_KEY = "X-TRACKERZ-REMINDER";

// A reminder is a point in time, not a meeting. Timed reminders get a nominal
// block so they render as something rather than a zero-length sliver.
const GC_DEFAULT_MINUTES = 30;

// ---- hashing ---------------------------------------------------------------

// Deterministic JSON: keys sorted, undefined dropped, no whitespace. Two
// structurally equal objects MUST serialise identically or the content gate is
// worthless - and JSON.stringify's key order follows insertion order, which
// differs between a body we built and a body we parsed out of an HTTP response.
function gcStableStringify(value) {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) parts.push(gcStableStringify(value[i]));
    return `[${parts.join(",")}]`;
  }
  if (t !== "object") return JSON.stringify(String(value));
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  const parts = [];
  for (let i = 0; i < keys.length; i++) {
    parts.push(`${JSON.stringify(keys[i])}:${gcStableStringify(value[keys[i]])}`);
  }
  return `{${parts.join(",")}}`;
}

// FNV-1a, two passes with different primes, 64 bits of output. Deliberately not
// crypto: SubtleCrypto is async and this has to be callable from the middle of a
// synchronous decision. The job is change detection, not tamper resistance.
function gcHash32(str, seed, prime) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), prime) >>> 0;
    h = Math.imul(h ^ ((c >>> 8) & 0xff), prime) >>> 0;
  }
  return h >>> 0;
}

function gcHash(str) {
  const s = String(str == null ? "" : str);
  const a = gcHash32(s, 2166136261, 16777619);
  const b = gcHash32(s, 2166136261 ^ s.length, 2654435761);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function gcContentHash(value) {
  return gcHash(gcStableStringify(value));
}

// ---- small date helpers (no Date object, same discipline as lib/reminders) ---

function gcPad2(n) {
  return String(n).padStart(2, "0");
}

const GC_DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function gcDaysInMonth(y, m) {
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29;
  return GC_DIM[m - 1];
}

function gcParseKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

// One day later. Google's all-day `end.date` is EXCLUSIVE, so a single-day
// event ends on the following date - getting this wrong makes every all-day
// reminder render as a zero-length event that some clients hide entirely.
function gcAddDay(key) {
  const p = gcParseKey(key);
  if (!p) return null;
  let { y, m, d } = p;
  d += 1;
  if (d > gcDaysInMonth(y, m)) { d = 1; m += 1; if (m > 12) { m = 1; y += 1; } }
  return `${String(y).padStart(4, "0")}-${gcPad2(m)}-${gcPad2(d)}`;
}

// "HH:MM" / "HH:MM:SS" -> minutes past local midnight, or null. Strict: a time
// we cannot read must not silently become midnight and move an 18:30 reminder
// to the top of the day.
function gcMinutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(hhmm == null ? "" : hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function gcClock(mins) {
  const n = Math.max(0, Math.floor(Number(mins) || 0));
  return `${gcPad2(Math.floor(n / 60) % 24)}:${gcPad2(n % 60)}`;
}

function gcTrim(s) {
  return String(s == null ? "" : s).trim();
}

// ---- normalisation: the part that makes the content hash survive Google -----

// An RRULE/EXDATE/RDATE line in a canonical form. Google rewrites what we send:
// it uppercases, reorders the parts, and adds WKST=MO (the RFC default, so it
// changes no dates). Comparing raw strings therefore reports a change on every
// round trip of an unchanged rule. Sorting the parts and dropping the default
// WKST is the smallest normalisation that survives that without hiding a real
// edit - any part that actually alters which dates fire is still in the hash.
function gcNormalizeRecurrenceLine(line) {
  const raw = gcTrim(line).toUpperCase();
  if (!raw) return "";
  const colon = raw.indexOf(":");
  if (colon === -1) return raw;
  const name = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  if (!/^RRULE/.test(name)) {
    // EXDATE / RDATE: a sorted date list. Order is not meaning.
    const items = value.split(",").map((x) => x.trim()).filter(Boolean).sort();
    return `${name.split(";")[0]}:${items.join(",")}`;
  }
  const parts = value.split(";")
    .map((p) => p.trim())
    .filter((p) => p && p !== "WKST=MO")
    .sort();
  return `RRULE:${parts.join(";")}`;
}

function gcNormalizeRecurrence(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const line = gcNormalizeRecurrenceLine(arr[i]);
    if (line && out.indexOf(line) === -1) out.push(line);
  }
  out.sort();
  return out;
}

// A Google start/end block, reduced to what we actually control.
//
// We SEND a floating `dateTime` ("2026-08-14T18:30:00") plus a `timeZone`;
// Google hands it BACK resolved ("2026-08-14T18:30:00+05:30") with the same
// timeZone. Keeping only the first 19 characters - the wall-clock time - plus
// the zone compares like with like. Comparing the raw strings would report a
// change on every single round trip, forever.
function gcNormalizeTimePoint(point) {
  if (!point || typeof point !== "object") return null;
  const date = gcTrim(point.date);
  if (date) return { date };
  const dt = gcTrim(point.dateTime);
  if (!dt) return null;
  return { dateTime: dt.slice(0, 19), timeZone: gcTrim(point.timeZone) };
}

// ---- building the event we intend to write ---------------------------------

// toRRule() emits iCalendar LINES including DTSTART. Google's `recurrence` field
// must NOT contain DTSTART - the start is carried by the event's own `start`
// field, and sending both is a 400 from the API.
function gcRecurrenceLines(body) {
  const lines = (body && Array.isArray(body.lines)) ? body.lines : [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = gcTrim(lines[i]);
    if (!line || /^DTSTART/i.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * The event body we send to Google, plus the hashable shape of it.
 *
 * `recurrence` is passed IN rather than derived here: mapping our rule parts to
 * an RRULE is lib/rrule-codec.mjs's job (it owns the clamp divergence, where
 * "the 31st" must not silently become 11 fires a year), and this block has to
 * stay import-free so it can be mirrored into Deno verbatim.
 */
function gcBuildEvent(input) {
  const reminder = input.reminder || {};
  const dtstart = gcTrim(input.dtstart) || gcTrim(reminder.dtstart) || gcTrim(reminder.on_date);
  const timeZone = gcTrim(input.timeZone) || gcTrim(reminder.timezone) || "Asia/Kolkata";
  const recurrence = gcNormalizeRecurrence(input.recurrence);
  const mins = gcMinutesOfDay(input.atTime != null ? input.atTime : reminder.at_time);
  const minutes = Number(input.durationMinutes) > 0 ? Number(input.durationMinutes) : GC_DEFAULT_MINUTES;

  let start = null;
  let end = null;
  if (!gcParseKey(dtstart)) {
    // No usable start date. Returning a half-built event would put a wrong date
    // in a real calendar, so this is an explicit refusal the caller must handle.
    return { error: "no start date for this reminder", event: null, shape: null, hash: "" };
  }
  if (mins == null) {
    start = { date: dtstart };
    end = { date: gcAddDay(dtstart) };
  } else {
    const endMins = mins + minutes;
    const endDate = endMins >= 1440 ? gcAddDay(dtstart) : dtstart;
    start = { dateTime: `${dtstart}T${gcClock(mins)}:00`, timeZone };
    end = { dateTime: `${endDate}T${gcClock(endMins % 1440)}:00`, timeZone };
  }

  const shape = {
    summary: gcTrim(reminder.title) || "Reminder",
    description: gcTrim(reminder.note),
    start: gcNormalizeTimePoint(start),
    end: gcNormalizeTimePoint(end),
    recurrence,
  };
  const hash = gcContentHash(shape);

  // `recurrence` is always present, even as []. An empty array is Google's own
  // way of saying "not recurring" and it CLEARS a rule on a PATCH, which is what
  // a reminder changed from weekly to one-off must do. Omitting the key on a
  // PATCH would leave the old rule in place - a reminder the user retired would
  // keep firing in their calendar forever.
  const event = {
    summary: shape.summary,
    description: shape.description,
    start,
    end,
    recurrence,
    extendedProperties: {
      private: {
        [GC_ORIGIN_KEY]: GC_ORIGIN_VALUE,
        [GC_HASH_KEY]: hash,
        [GC_REMINDER_KEY]: gcTrim(reminder.id),
      },
    },
  };
  return { error: "", event, shape, hash };
}

// The same hashable shape, read back OUT of whatever Google returned. Only the
// fields we set: an event also carries created/updated/iCalUID/sequence/htmlLink
// /organizer/reminders, none of which we control, all of which move on their own.
function gcRemoteShape(event) {
  const e = event || {};
  return {
    summary: gcTrim(e.summary) || "Reminder",
    description: gcTrim(e.description),
    start: gcNormalizeTimePoint(e.start),
    end: gcNormalizeTimePoint(e.end),
    recurrence: gcNormalizeRecurrence(e.recurrence),
  };
}

function gcRemoteHash(event) {
  return gcContentHash(gcRemoteShape(event));
}

// ---- guard 3: authorship ----------------------------------------------------

function gcPrivateProps(event) {
  const ep = event && event.extendedProperties;
  const priv = ep && ep.private;
  return (priv && typeof priv === "object") ? priv : {};
}

function gcOriginOf(event) {
  return gcTrim(gcPrivateProps(event)[GC_ORIGIN_KEY]);
}

/** True when WE created this event. Says nothing about who edited it last. */
function gcIsOurs(event) {
  return gcOriginOf(event) === GC_ORIGIN_VALUE;
}

/** The content hash we stamped when we last wrote it (before Google normalised). */
function gcStampedHashOf(event) {
  return gcTrim(gcPrivateProps(event)[GC_HASH_KEY]);
}

/** The reminder id we stamped, so a lost link row can be rebuilt from the event. */
function gcReminderIdOf(event) {
  return gcTrim(gcPrivateProps(event)[GC_REMINDER_KEY]);
}

// ---- the decisions ----------------------------------------------------------

/**
 * Should we write this reminder to the remote calendar?
 *
 * Returns one of:
 *   create  - no link yet
 *   update  - the content we control changed since our last successful push
 *   delete  - the LOCAL row carries an explicit tombstone (deleted_at / active
 *             false with a tombstone). Never from absence; see the file header.
 *   noop    - the content hash equals what we last pushed (guard 1)
 *   blocked - the reminder cannot be expressed as an event at all
 */
function gcDecidePush(input) {
  const reminder = input.reminder || {};
  const link = input.link || null;
  const built = input.built || null;
  // Every branch returns the SAME key set. A decision whose shape depends on its
  // outcome forces every caller to re-derive which fields are safe to read, and
  // the TypeScript mirror of this block would not compile at all.
  const out = { action: "noop", reason: "", eventId: "", hash: "" };
  if (link && link.event_id) out.eventId = String(link.event_id);

  const tombstoned = Boolean(reminder.deleted_at);
  if (tombstoned) {
    if (!out.eventId) return { ...out, reason: "deleted locally and never pushed" };
    if (link.remote_deleted_at) return { ...out, reason: "already gone remotely" };
    return { ...out, action: "delete", reason: "local row carries an explicit tombstone" };
  }

  if (reminder.active === false) {
    // Paused, not deleted. Deleting the remote event would lose the user's own
    // edits to it; leaving it is honest and reversible.
    return { ...out, reason: "reminder is paused; the remote event is left alone" };
  }

  if (!built || built.error) {
    return { ...out, action: "blocked", reason: built && built.error ? String(built.error) : "no event body could be built" };
  }
  out.hash = String(built.hash || "");

  if (!out.eventId) {
    return { ...out, action: "create", reason: "no link for this reminder yet" };
  }

  // GUARD 1 - the content gate. This is the line that makes a 100-iteration
  // pull/push/pull loop settle at exactly one write.
  if (gcTrim(link.local_hash) === out.hash) {
    return { ...out, reason: "content hash matches the last push" };
  }

  return { ...out, action: "update", reason: "local content changed since the last push" };
}

/**
 * What does this remote event mean for us?
 *
 * Returns one of:
 *   tombstone - an EXPLICIT remote cancellation (the only delete signal there is)
 *   noop      - guard 2 (etag) or guard 1 (remote content hash) says nothing moved
 *   apply     - a genuine remote edit to an event we own, including one the user
 *               made by hand to an event we created (which still carries our
 *               origin stamp - guard 3 alone would have thrown this away)
 *   adopt     - an event we created but have no link row for; rebuild the link
 *   mirror    - somebody else's event: copy into calendar_events_raw, read-only
 */
function gcDecidePull(input) {
  const event = input.event || {};
  const link = input.link || null;
  const ours = gcIsOurs(event);
  // Same discipline as gcDecidePush: one key set, every branch.
  const out = {
    action: "noop",
    reason: "",
    ours,
    hash: gcRemoteHash(event),
    reminderId: gcReminderIdOf(event) || (link ? gcTrim(link.reminder_id) : ""),
    updatedAt: gcTrim(event.updated),
  };

  // The ONLY delete signal. Applies to ours and to mirrored events alike.
  if (gcTrim(event.status) === "cancelled") {
    return { ...out, action: "tombstone", reason: "explicit remote cancellation" };
  }

  if (!ours) {
    return { ...out, action: "mirror", reason: "third-party event; read-only mirror" };
  }

  if (!link || !link.event_id) {
    // Our stamp, no link row: a lost link (a full resync after a 410, a restored
    // backup). Rebuilding beats creating a duplicate event.
    return { ...out, action: "adopt", reason: "our event with no link row" };
  }

  // GUARD 2 - the etag echo. Google returns the post-normalisation etag in the
  // response to our own write, so an identical etag means this IS our write.
  if (gcTrim(event.etag) && gcTrim(event.etag) === gcTrim(link.etag)) {
    return { ...out, reason: "etag matches the version we wrote" };
  }

  // GUARD 1 on the pull side - the etag moved (an attendee replied, a reminder
  // override changed) but nothing WE care about did.
  if (gcTrim(link.remote_hash) === out.hash) {
    return { ...out, reason: "remote content hash unchanged" };
  }

  // GUARD 3 is deliberately NOT consulted here as an echo test. The event
  // carries our origin AND its content moved, which is precisely the case
  // "origin alone" gets wrong: the user edited an event we created.
  return { ...out, action: "apply", reason: "remote content changed on an event we own" };
}

/**
 * Both sides moved since the last sync. Somebody's edit is going to lose, so say
 * out loud which one and why - a conflict resolved silently is a change the user
 * made and never saw again.
 *
 * Remote wins ties. The user editing their own calendar is a deliberate act with
 * a UI in front of it; our local row can be a rule the agent inferred from a
 * sentence. The loser is returned as `dropped` so the caller can surface it.
 */
function gcResolveConflict(input) {
  const localAt = Date.parse(gcTrim(input.localUpdatedAt)) || 0;
  const remoteAt = Date.parse(gcTrim(input.remoteUpdatedAt)) || 0;
  if (localAt && remoteAt && localAt > remoteAt) {
    return { winner: "local", reason: "local edit is newer", dropped: "remote" };
  }
  if (remoteAt && !localAt) return { winner: "remote", reason: "only the remote side has a timestamp", dropped: "local" };
  if (localAt && !remoteAt) return { winner: "local", reason: "only the local side has a timestamp", dropped: "remote" };
  return { winner: "remote", reason: "remote wins ties; the user touched their own calendar", dropped: "local" };
}

/**
 * The whole plan for one sync pass, as data.
 *
 * input:
 *   reminders  - local rows (each optionally with a prebuilt `built` from
 *                gcBuildEvent, keyed below by `builtFor`)
 *   events     - remote events from this pull (may be a partial page)
 *   links      - existing calendar_links rows
 *   builtFor   - { [reminderId]: gcBuildEvent(...) result }
 *
 * OUT: { pushes, pulls, conflicts, notes }. Nothing here performs I/O, and
 * nothing here can produce a remote delete from a missing local row: `pushes`
 * only ever carries a delete for a reminder that is PRESENT and tombstoned.
 */
function gcPlanSync(input) {
  const reminders = input.reminders || [];
  const events = input.events || [];
  const links = input.links || [];
  const builtFor = input.builtFor || {};

  const linkByEvent = {};
  const linkByReminder = {};
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (!l) continue;
    if (l.event_id) linkByEvent[String(l.event_id)] = l;
    if (l.reminder_id) linkByReminder[String(l.reminder_id)] = l;
  }

  const pulls = [];
  const conflicts = [];
  const notes = [];
  // Which reminders the remote just changed. Pushing our stale copy over a fresh
  // remote edit in the same pass is the other way a sync loops.
  const remoteMoved = {};

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const id = gcTrim(event && event.id);
    if (!id) { notes.push("remote event with no id was skipped"); continue; }
    const link = linkByEvent[id] || null;
    const decision = gcDecidePull({ event, link });
    pulls.push({ eventId: id, ...decision });
    if (decision.action === "apply" || decision.action === "tombstone") {
      const rid = gcTrim(decision.reminderId);
      if (rid) remoteMoved[rid] = decision;
    }
  }

  const pushes = [];
  for (let i = 0; i < reminders.length; i++) {
    const reminder = reminders[i];
    const rid = gcTrim(reminder && reminder.id);
    if (!rid) { notes.push("local reminder with no id was skipped"); continue; }
    const link = linkByReminder[rid] || null;
    const built = builtFor[rid] || null;
    const decision = gcDecidePush({ reminder, link, built });

    if (decision.action === "update" && remoteMoved[rid]) {
      const resolved = gcResolveConflict({
        localUpdatedAt: reminder.updated_at,
        remoteUpdatedAt: remoteMoved[rid].updatedAt,
      });
      conflicts.push({ reminderId: rid, ...resolved });
      if (resolved.winner === "remote") {
        pushes.push({ reminderId: rid, action: "noop", reason: `conflict: ${resolved.reason}` });
        continue;
      }
    }
    pushes.push({ reminderId: rid, ...decision });
  }

  return { pushes, pulls, conflicts, notes };
}

/**
 * Is this remote error the "your sync token expired" one?
 *
 * 410 GONE is NORMAL CONTROL FLOW, not a failure: Google expires sync tokens
 * (and always has), and the documented response is to drop the token and do a
 * full resync. Reporting it as an error would light the "sync broken" banner on
 * a healthy integration; retrying with the same token loops forever.
 */
function gcIsSyncTokenExpired(status, body) {
  if (Number(status) === 410) return true;
  const text = gcTrim(body).toLowerCase();
  return text.indexOf("fullsyncrequired") !== -1 || text.indexOf("sync token is no longer valid") !== -1;
}

/**
 * Is this remote error one that retrying cannot fix?
 *
 * These are the ones that must set sync_broken_since and light the banner. An
 * expired or revoked refresh token is the single most common failure of this
 * integration (Google's OAuth "Testing" mode revokes every refresh token after
 * 7 days), and its natural presentation is an empty calendar that looks fine.
 */
function gcIsAuthFailure(status, body) {
  const s = Number(status);
  if (s === 401) return true;
  const text = gcTrim(body).toLowerCase();
  if (text.indexOf("invalid_grant") !== -1) return true;
  if (text.indexOf("token has been expired or revoked") !== -1) return true;
  if (s === 403 && (text.indexOf("insufficientpermissions") !== -1 || text.indexOf("insufficient permission") !== -1)) return true;
  return false;
}
// ==== GCAL-SYNC MIRROR END ====

// ==== END OF MIRRORED CODE ==================================================

// -------- Google config --------

type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webhookUrl: string;
  missing: string[];
  configured: boolean;
};

async function googleConfig(): Promise<GoogleConfig> {
  const clientId = (await resolveSecretOptional("GOOGLE_CLIENT_ID")) || "";
  const clientSecret = (await resolveSecretOptional("GOOGLE_CLIENT_SECRET")) || "";
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  const redirectUri = (await resolveSecretOptional("GOOGLE_REDIRECT_URI")) || `${base}/functions/v1/gcal/callback`;
  const webhookUrl = (await resolveSecretOptional("GCAL_WEBHOOK_URL")) || `${base}/functions/v1/gcal/webhook`;
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  return { clientId, clientSecret, redirectUri, webhookUrl, missing, configured: missing.length === 0 };
}

function notConfigured(cfg: GoogleConfig) {
  return {
    ok: false,
    error: "not_configured",
    missing: cfg.missing,
    // The exact sentence the UI shows. Written here so the server and the panel
    // cannot disagree about what is wrong.
    message: `Google Calendar is not connected because ${cfg.missing.join(" and ")} ${cfg.missing.length > 1 ? "are" : "is"} not set on this project. Everything else is built and deployed - see docs/GOOGLE-CALENDAR-SETUP.md.`,
    setup_doc: "docs/GOOGLE-CALENDAR-SETUP.md",
  };
}

// -------- token handling (server-side only, never returned to a client) ------

async function exchangeCode(cfg: GoogleConfig, code: string) {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * A usable access token for this account, refreshing when needed.
 *
 * Throws with a message the caller turns into sync_broken_since when the grant
 * is gone. `invalid_grant` here means the refresh token was revoked or expired -
 * the single most common failure of this integration, and the one that produces
 * an empty calendar rather than an error unless somebody says so out loud.
 */
async function accessTokenFor(admin: any, cfg: GoogleConfig, accountId: string): Promise<string> {
  const { data: secret, error } = await admin
    .from("calendar_secrets")
    .select("refresh_token, access_token, access_token_expires_at")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw new Error(`calendar_secrets read failed: ${error.message}`);
  if (!secret || !secret.refresh_token) {
    throw new Error("no refresh token stored for this account - reconnect Google Calendar");
  }

  const expiresAt = secret.access_token_expires_at ? Date.parse(secret.access_token_expires_at) : 0;
  // 60s of slack so a token does not expire mid-request.
  if (secret.access_token && expiresAt > Date.now() + 60000) return secret.access_token;

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: secret.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const token = String(json.access_token || "");
  if (!token) throw new Error("token refresh returned no access_token");
  const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
  const { error: upErr } = await admin.from("calendar_secrets").update({
    access_token: token,
    access_token_expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("account_id", accountId);
  if (upErr) console.error(`could not cache access token for ${accountId}: ${upErr.message}`);
  return token;
}

type CalResult = { ok: boolean; status: number; body: string; json: any };

async function calFetch(token: string, path: string, init: RequestInit = {}): Promise<CalResult> {
  const res = await fetch(`${CAL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  let json: any = null;
  if (body) {
    try {
      json = JSON.parse(body);
    } catch {
      json = null; // a non-JSON body is still reported verbatim through `body`
    }
  }
  return { ok: res.ok, status: res.status, body, json };
}

// -------- account health --------

/**
 * Mark an account broken, with a reason, ONCE.
 *
 * sync_broken_since is set on the FIRST failure and never moved by a later one,
 * so "broken for 11 days" is answerable. It is cleared only by a successful
 * sync, in markHealthy().
 */
async function markBroken(admin: any, accountId: string, reason: string, needsReauth = false) {
  const patch: any = {
    sync_broken_reason: String(reason).slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  if (needsReauth) patch.status = "needs_reauth";
  const { data: row, error: readErr } = await admin
    .from("calendar_accounts").select("sync_broken_since").eq("id", accountId).maybeSingle();
  if (readErr) console.error(`markBroken read failed for ${accountId}: ${readErr.message}`);
  if (!row || !row.sync_broken_since) patch.sync_broken_since = new Date().toISOString();
  const { error } = await admin.from("calendar_accounts").update(patch).eq("id", accountId);
  if (error) console.error(`markBroken write failed for ${accountId}: ${error.message}`);
}

async function markHealthy(admin: any, accountId: string, patch: any = {}) {
  const { error } = await admin.from("calendar_accounts").update({
    sync_broken_since: null,
    sync_broken_reason: null,
    status: "connected",
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...patch,
  }).eq("id", accountId);
  if (error) console.error(`markHealthy failed for ${accountId}: ${error.message}`);
}

// -------- the dedicated calendar --------

/**
 * Find or create the calendar we own.
 *
 * Order matters: reuse the id we already stored, then look for one we made
 * earlier under the same name, and only then create. Creating first would leave
 * a trail of empty "Deno" calendars in the user's sidebar every time they
 * reconnect.
 */
async function ensureOurCalendar(token: string, existingId: string): Promise<{ id: string; summary: string; created: boolean; note: string }> {
  if (existingId) {
    const got = await calFetch(token, `/calendars/${encodeURIComponent(existingId)}`);
    if (got.ok) return { id: existingId, summary: String(got.json?.summary || OUR_CALENDAR_SUMMARY), created: false, note: "reused the stored calendar" };
    if (got.status !== 404 && got.status !== 403) {
      throw new Error(`calendar lookup ${got.status}: ${got.body.slice(0, 200)}`);
    }
  }

  const list = await calFetch(token, "/users/me/calendarList?maxResults=250&minAccessRole=owner");
  if (list.ok && Array.isArray(list.json?.items)) {
    for (const item of list.json.items) {
      if (String(item?.summary || "") === OUR_CALENDAR_SUMMARY) {
        return { id: String(item.id), summary: OUR_CALENDAR_SUMMARY, created: false, note: "found an existing app calendar" };
      }
    }
  }

  const made = await calFetch(token, "/calendars", {
    method: "POST",
    body: JSON.stringify({ summary: OUR_CALENDAR_SUMMARY, description: "Reminders written by Deno. Safe to delete - nothing else is touched.", timeZone: "Asia/Kolkata" }),
  });
  if (!made.ok) throw new Error(`could not create the app calendar (${made.status}): ${made.body.slice(0, 300)}`);
  return { id: String(made.json?.id || ""), summary: OUR_CALENDAR_SUMMARY, created: true, note: list.ok ? "created a new app calendar" : "created a new app calendar (calendar list was not readable)" };
}

// -------- watch channels --------

function randomId(): string {
  return crypto.randomUUID();
}

async function registerWatch(admin: any, cfg: GoogleConfig, account: any, token: string) {
  const channelId = randomId();
  const channelToken = randomId().replace(/-/g, "");
  const res = await calFetch(token, `/calendars/${encodeURIComponent(account.calendar_id)}/events/watch`, {
    method: "POST",
    body: JSON.stringify({
      id: channelId,
      type: "web_hook",
      address: cfg.webhookUrl,
      token: channelToken,
      params: { ttl: String(CHANNEL_TTL_SECONDS) },
    }),
  });
  if (!res.ok) {
    // A watch channel is an OPTIMISATION. Failing to register one must not fail
    // the connection: the 5-minute poll still keeps the calendar current, and
    // saying so beats pretending the connection did not work.
    return { ok: false, reason: `watch ${res.status}: ${res.body.slice(0, 200)}` };
  }
  const expiration = Number(res.json?.expiration);
  const { error } = await admin.from("calendar_accounts").update({
    channel_id: channelId,
    channel_resource_id: String(res.json?.resourceId || ""),
    channel_expiry: Number.isFinite(expiration) && expiration > 0 ? new Date(expiration).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  if (error) return { ok: false, reason: `channel stored badly: ${error.message}` };
  const { error: secErr } = await admin.from("calendar_secrets")
    .update({ channel_token: channelToken, updated_at: new Date().toISOString() })
    .eq("account_id", account.id);
  if (secErr) return { ok: false, reason: `channel token not stored: ${secErr.message}` };
  return { ok: true, reason: "", channelId, expiration };
}

async function stopWatch(cfg: GoogleConfig, token: string, channelId: string, resourceId: string) {
  if (!channelId || !resourceId) return { ok: true, reason: "no channel to stop" };
  const res = await calFetch(token, "/channels/stop", {
    method: "POST",
    body: JSON.stringify({ id: channelId, resourceId }),
  });
  return { ok: res.ok, reason: res.ok ? "" : `stop ${res.status}: ${res.body.slice(0, 200)}` };
}

// -------- PULL --------

/**
 * Incremental sync of one calendar.
 *
 * 410 GONE (or a FullSyncRequired body) drops the token and does a full resync -
 * that is Google's documented contract, not an error. `showDeleted=true` is what
 * makes an explicit tombstone visible at all; without it a cancelled event is
 * simply absent, and absence is exactly the signal we refuse to act on.
 */
async function fetchEventPages(token: string, calendarId: string, syncToken: string) {
  const collected: any[] = [];
  let pageToken = "";
  let nextSyncToken = "";
  let usedSyncToken = syncToken;
  let fullResync = false;

  for (let guard = 0; guard < 40; guard++) {
    const params = new URLSearchParams({ showDeleted: "true", maxResults: "250", singleEvents: "false" });
    if (usedSyncToken) params.set("syncToken", usedSyncToken);
    else params.set("timeMin", new Date(Date.now() - 180 * 86400000).toISOString());
    if (pageToken) params.set("pageToken", pageToken);

    const res = await calFetch(token, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
    if (!res.ok) {
      if (gcIsSyncTokenExpired(res.status, res.body) && usedSyncToken) {
        // NORMAL CONTROL FLOW. Drop the cursor, start again from scratch.
        usedSyncToken = "";
        pageToken = "";
        fullResync = true;
        collected.length = 0;
        continue;
      }
      throw new Error(`events.list ${res.status}: ${res.body.slice(0, 300)}`);
    }
    const items = Array.isArray(res.json?.items) ? res.json.items : [];
    for (const item of items) collected.push(item);
    pageToken = String(res.json?.nextPageToken || "");
    nextSyncToken = String(res.json?.nextSyncToken || nextSyncToken);
    if (!pageToken) break;
  }
  return { events: collected, nextSyncToken, fullResync };
}

/** Turn one remote event into a calendar_events_raw row. */
function rawRowFor(event: any, userId: string, accountId: string, calendarId: string) {
  const start = event?.start || {};
  const end = event?.end || {};
  const allDay = Boolean(start.date) && !start.dateTime;
  return {
    user_id: userId,
    account_id: accountId,
    calendar_id: calendarId,
    event_id: String(event?.id || ""),
    etag: String(event?.etag || ""),
    status: String(event?.status || ""),
    summary: String(event?.summary || ""),
    description: String(event?.description || ""),
    location: String(event?.location || ""),
    organizer_email: String(event?.organizer?.email || ""),
    attendees: Array.isArray(event?.attendees) ? event.attendees : [],
    starts_at: start.dateTime || null,
    ends_at: end.dateTime || null,
    all_day: allDay,
    start_date: start.date || null,
    recurrence: Array.isArray(event?.recurrence) ? event.recurrence : null,
    recurring_event_id: String(event?.recurringEventId || "") || null,
    html_link: String(event?.htmlLink || "") || null,
    remote_updated_at: event?.updated || null,
    last_seen_at: new Date().toISOString(),
  };
}

async function pullAccount(admin: any, cfg: GoogleConfig, account: any) {
  const token = await accessTokenFor(admin, cfg, account.id);
  const summary: any = {
    accountId: account.id,
    ownPulled: 0, applied: 0, adopted: 0, tombstoned: 0, mirrored: 0,
    fullResync: false, notes: [] as string[],
  };

  // --- our own calendar: the two-way half -----------------------------------
  if (!account.calendar_id) {
    summary.notes.push("no app calendar id on this account - reconnect");
    return summary;
  }
  const own = await fetchEventPages(token, account.calendar_id, account.sync_token || "");
  summary.ownPulled = own.events.length;
  summary.fullResync = own.fullResync;

  const eventIds = own.events.map((e: any) => String(e?.id || "")).filter(Boolean);
  let links: any[] = [];
  if (eventIds.length) {
    const { data, error } = await admin.from("calendar_links")
      .select("*").eq("account_id", account.id).in("event_id", eventIds);
    if (error) throw new Error(`calendar_links read failed: ${error.message}`);
    links = data || [];
  }
  const linkByEvent: Record<string, any> = {};
  for (const l of links) linkByEvent[String(l.event_id)] = l;

  for (const event of own.events) {
    const eventId = String(event?.id || "");
    if (!eventId) continue;
    const link = linkByEvent[eventId] || null;
    const decision = gcDecidePull({ event, link });

    if (decision.action === "tombstone") {
      summary.tombstoned += 1;
      if (link) {
        const { error } = await admin.from("calendar_links")
          .update({ remote_deleted_at: new Date().toISOString(), etag: String(event?.etag || ""), updated_at: new Date().toISOString() })
          .eq("id", link.id);
        if (error) summary.notes.push(`tombstone not recorded for ${eventId}: ${error.message}`);
      }
      continue;
    }
    if (decision.action === "noop") continue;

    if (decision.action === "adopt") {
      // Our stamp with no link row. Rebuild the link rather than let push create
      // a duplicate event on the next pass.
      const reminderId = decision.reminderId || null;
      const { error } = await admin.from("calendar_links").upsert({
        user_id: account.user_id,
        account_id: account.id,
        reminder_id: reminderId,
        event_id: eventId,
        calendar_id: account.calendar_id,
        etag: String(event?.etag || ""),
        remote_hash: decision.hash,
        origin: "local",
        last_pulled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "account_id,event_id" });
      if (error) summary.notes.push(`adopt failed for ${eventId}: ${error.message}`);
      else summary.adopted += 1;
      continue;
    }

    if (decision.action === "apply") {
      // A genuine remote edit to an event we created. The title and note are the
      // only fields a hand edit can move that our rule shape can carry - the
      // recurrence stays ours, because Google's RRULE dialect is richer than our
      // engine and silently importing one we cannot express would move dates.
      summary.applied += 1;
      const patch: any = { updated_at: new Date().toISOString() };
      if (event.summary) patch.title = String(event.summary).slice(0, 200);
      if (typeof event.description === "string") patch.note = event.description.slice(0, 2000);
      if (link?.reminder_id) {
        const { error } = await admin.from("reminders").update(patch).eq("id", link.reminder_id);
        if (error) summary.notes.push(`could not apply remote edit to reminder ${link.reminder_id}: ${error.message}`);
      } else {
        summary.notes.push(`remote edit on ${eventId} has no local reminder to apply to`);
      }
      const { error: linkErr } = await admin.from("calendar_links").update({
        etag: String(event?.etag || ""),
        remote_hash: decision.hash,
        last_pulled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("account_id", account.id).eq("event_id", eventId);
      if (linkErr) summary.notes.push(`link not updated for ${eventId}: ${linkErr.message}`);
    }
  }

  const ownPatch: any = {};
  if (own.nextSyncToken) {
    ownPatch.sync_token = own.nextSyncToken;
    ownPatch.sync_token_updated_at = new Date().toISOString();
  }
  if (own.fullResync) ownPatch.last_full_sync_at = new Date().toISOString();

  // --- everybody else's calendar: the read-only mirror ----------------------
  const mirrorId = account.mirror_calendar_id || "primary";
  const canMirror = Array.isArray(account.scopes)
    && account.scopes.some((s: string) => String(s).includes("calendar.events.readonly") || String(s).includes("auth/calendar.readonly"));
  if (canMirror) {
    try {
      const other = await fetchEventPages(token, mirrorId, account.mirror_sync_token || "");
      for (const event of other.events) {
        const eventId = String(event?.id || "");
        if (!eventId) continue;
        const cancelled = String(event?.status || "") === "cancelled";
        const row: any = rawRowFor(event, account.user_id, account.id, mirrorId);
        // THE TOMBSTONE, and the only way one is ever set.
        row.tombstoned_at = cancelled ? new Date().toISOString() : null;
        const { error } = await admin.from("calendar_events_raw").upsert(row, { onConflict: "account_id,event_id" });
        if (error) summary.notes.push(`mirror row failed for ${eventId}: ${error.message}`);
        else summary.mirrored += 1;
      }
      if (other.nextSyncToken) ownPatch.mirror_sync_token = other.nextSyncToken;
    } catch (err) {
      // The mirror is a nice-to-have; our own calendar syncing is not. Report the
      // failure and keep the account healthy rather than lighting the banner for
      // a read scope the user may never have granted.
      summary.notes.push(`mirror pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    summary.notes.push("read scope not granted - third-party calendars are not mirrored");
  }

  await markHealthy(admin, account.id, ownPatch);
  return summary;
}

// -------- PUSH --------

const REMINDER_COLUMNS = "id, title, note, kind, freq, day_of_month, month_of_year, weekday, on_date, lead_days, active, created_at, updated_at, deleted_at"
  + ", rule_interval, dtstart, nth_weekday, weekdays, until, max_count, exdates, rdates, at_time, timezone";

/** One reminder row -> the Google event body plus its hash. */
function buildEventFor(reminder: any, timezone: string) {
  const body = toRRule(reminder || {}, { since: null });
  if (body.error) return { error: String(body.error), event: null, shape: null, hash: "" };
  const recurrence = gcNormalizeRecurrence(gcRecurrenceLines(body));
  return gcBuildEvent({
    reminder,
    dtstart: body.dtstart,
    recurrence,
    timeZone: reminder?.timezone || timezone || "Asia/Kolkata",
    durationMinutes: null,
    atTime: null,
  });
}

async function pushAccount(admin: any, cfg: GoogleConfig, account: any) {
  const token = await accessTokenFor(admin, cfg, account.id);
  const summary: any = { accountId: account.id, created: 0, updated: 0, deleted: 0, blocked: 0, noop: 0, notes: [] as string[] };
  if (!account.calendar_id) {
    summary.notes.push("no app calendar id on this account - reconnect");
    return summary;
  }

  // Soft-deleted rows are INCLUDED on purpose: a tombstoned reminder is the only
  // thing that may ever produce a remote delete, and it can only do that if the
  // query returns it. Absence still means nothing.
  const { data: reminders, error } = await admin
    .from("reminders").select(REMINDER_COLUMNS).eq("user_id", account.user_id);
  if (error) throw new Error(`reminders read failed: ${error.message}`);

  const { data: linkRows, error: linkErr } = await admin
    .from("calendar_links").select("*").eq("account_id", account.id);
  if (linkErr) throw new Error(`calendar_links read failed: ${linkErr.message}`);
  const linkByReminder: Record<string, any> = {};
  for (const l of linkRows || []) if (l.reminder_id) linkByReminder[String(l.reminder_id)] = l;

  const calPath = `/calendars/${encodeURIComponent(account.calendar_id)}/events`;

  for (const reminder of reminders || []) {
    const link = linkByReminder[String(reminder.id)] || null;
    const built = reminder.deleted_at ? null : buildEventFor(reminder, account.timezone || "Asia/Kolkata");
    const decision = gcDecidePush({ reminder, link, built });

    if (decision.action === "noop") { summary.noop += 1; continue; }
    if (decision.action === "blocked") {
      summary.blocked += 1;
      // A rule that cannot be expressed is REPORTED. Exporting nothing and
      // saying nothing is how a reminder quietly stops existing in the calendar
      // the user is actually looking at.
      summary.notes.push(`"${reminder.title}" cannot be exported: ${decision.reason}`);
      continue;
    }

    if (decision.action === "delete") {
      const res = await calFetch(token, `${calPath}/${encodeURIComponent(decision.eventId)}`, { method: "DELETE" });
      // 410 here means it is already gone, which is the outcome we wanted.
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        summary.notes.push(`delete failed for ${decision.eventId}: ${res.status} ${res.body.slice(0, 160)}`);
        continue;
      }
      summary.deleted += 1;
      const { error: delErr } = await admin.from("calendar_links")
        .update({ remote_deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("account_id", account.id).eq("event_id", decision.eventId);
      if (delErr) summary.notes.push(`delete not recorded for ${decision.eventId}: ${delErr.message}`);
      continue;
    }

    const isCreate = decision.action === "create";
    const res = isCreate
      ? await calFetch(token, calPath, { method: "POST", body: JSON.stringify(built!.event) })
      : await calFetch(token, `${calPath}/${encodeURIComponent(decision.eventId)}`, { method: "PATCH", body: JSON.stringify(built!.event) });

    if (!res.ok) {
      summary.notes.push(`${decision.action} failed for "${reminder.title}": ${res.status} ${res.body.slice(0, 200)}`);
      continue;
    }
    if (isCreate) summary.created += 1; else summary.updated += 1;

    // Store all three guards from the RESPONSE, not from what we sent: the etag
    // and the post-normalisation content are what the next pull will see, and
    // recording our pre-normalisation version is what makes a sync loop.
    const eventId = String(res.json?.id || decision.eventId);
    const { error: upErr } = await admin.from("calendar_links").upsert({
      user_id: account.user_id,
      account_id: account.id,
      reminder_id: reminder.id,
      event_id: eventId,
      calendar_id: account.calendar_id,
      etag: String(res.json?.etag || ""),
      local_hash: decision.hash,
      remote_hash: gcRemoteHash(res.json),
      origin: "local",
      remote_deleted_at: null,
      last_pushed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id,event_id" });
    if (upErr) summary.notes.push(`link not stored for ${eventId}: ${upErr.message}`);
  }

  const { error: touchErr } = await admin.from("calendar_accounts")
    .update({ last_push_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", account.id);
  if (touchErr) summary.notes.push(`last_push_at not stored: ${touchErr.message}`);
  return summary;
}

// -------- one full sync pass, with the failure classified --------

async function syncAccount(admin: any, cfg: GoogleConfig, account: any) {
  try {
    const pulled = await pullAccount(admin, cfg, account);
    const { data: fresh } = await admin.from("calendar_accounts").select("*").eq("id", account.id).maybeSingle();
    const pushed = await pushAccount(admin, cfg, fresh || account);
    return { ok: true, accountId: account.id, pull: pulled, push: pushed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const authFailed = gcIsAuthFailure(0, message) || /no refresh token stored/.test(message);
    await markBroken(admin, account.id, message, authFailed);
    return { ok: false, accountId: account.id, error: message, needsReauth: authFailed };
  }
}

// -------- actions --------

async function actionAuthUrl(admin: any, cfg: GoogleConfig, userId: string, payload: any) {
  if (!cfg.configured) return notConfigured(cfg);
  const wantRead = payload?.scopes !== "write";
  const scopes = wantRead ? [...SCOPE_WRITE, ...SCOPE_READ] : [...SCOPE_WRITE];
  const state = randomId().replace(/-/g, "") + randomId().replace(/-/g, "");
  const redirectTo = pickRedirect(String(payload?.redirect_to || ""));

  const { error } = await admin.from("calendar_oauth_states").insert({
    state, user_id: userId, provider: "google", redirect_to: redirectTo, scopes,
  });
  if (error) return { ok: false, error: `could not start the OAuth flow: ${error.message}` };

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    // access_type=offline AND prompt=consent, together. Offline alone returns a
    // refresh token only on the FIRST ever consent for this client; every later
    // connect silently returns none, and the integration then works until the
    // access token expires an hour later and never again.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return { ok: true, url: `${GOOGLE_AUTH_URL}?${params.toString()}`, scopes, redirect_to: redirectTo };
}

function pickRedirect(requested: string): string {
  const want = String(requested || "").trim();
  if (!want) return DEFAULT_REDIRECT;
  for (const prefix of ALLOWED_REDIRECT_PREFIXES) {
    if (want.startsWith(prefix)) return want;
  }
  return DEFAULT_REDIRECT;
}

function redirectWith(target: string, params: Record<string, string>) {
  const url = new URL(target);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}

async function actionCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const oauthError = url.searchParams.get("error") || "";

  const admin = adminClient();
  const cfg = await googleConfig();

  const { data: stateRow, error: stateErr } = await admin
    .from("calendar_oauth_states").select("*").eq("state", state).maybeSingle();
  const target = pickRedirect(stateRow?.redirect_to || "");

  if (stateErr) return redirectWith(target, { gcal: "error", reason: `state lookup failed: ${stateErr.message}` });
  if (!stateRow) return redirectWith(target, { gcal: "error", reason: "this sign-in link is not one we issued (or it was already used)" });
  if (stateRow.used_at) return redirectWith(target, { gcal: "error", reason: "this sign-in link was already used" });
  if (Date.parse(stateRow.expires_at) < Date.now()) return redirectWith(target, { gcal: "error", reason: "this sign-in link expired - try connecting again" });
  await admin.from("calendar_oauth_states").update({ used_at: new Date().toISOString() }).eq("state", state);

  if (oauthError) return redirectWith(target, { gcal: "error", reason: `Google said: ${oauthError}` });
  if (!cfg.configured) return redirectWith(target, { gcal: "error", reason: notConfigured(cfg).message });
  if (!code) return redirectWith(target, { gcal: "error", reason: "Google returned no authorization code" });

  try {
    const tokens = await exchangeCode(cfg, code);
    const refreshToken = String(tokens.refresh_token || "");
    const accessToken = String(tokens.access_token || "");
    if (!accessToken) throw new Error("no access token in the exchange response");
    if (!refreshToken) {
      // Without a refresh token this connection dies in an hour and looks fine
      // until it does. prompt=consent is meant to prevent this; if it still
      // happens, say so instead of storing a doomed account.
      throw new Error("Google returned no refresh token. Remove this app at myaccount.google.com/permissions and connect again - without a refresh token the link stops working within the hour.");
    }

    const who = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    const whoBody = await who.text();
    const email = who.ok ? String((JSON.parse(whoBody) || {}).email || "") : "";
    if (!who.ok) console.error(`userinfo ${who.status}: ${whoBody.slice(0, 200)}`);

    const scopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);

    const { data: existing } = await admin.from("calendar_accounts")
      .select("*").eq("user_id", stateRow.user_id).eq("provider", "google")
      .eq("external_account_email", email).maybeSingle();

    const cal = await ensureOurCalendar(accessToken, existing?.calendar_id || "");

    const { data: account, error: accErr } = await admin.from("calendar_accounts").upsert({
      ...(existing ? { id: existing.id } : {}),
      user_id: stateRow.user_id,
      provider: "google",
      external_account_email: email,
      calendar_id: cal.id,
      calendar_summary: cal.summary,
      scopes,
      status: "connected",
      sync_broken_since: null,
      sync_broken_reason: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,provider,external_account_email" }).select().single();
    if (accErr) throw new Error(`could not store the account: ${accErr.message}`);

    const { error: secErr } = await admin.from("calendar_secrets").upsert({
      account_id: account.id,
      refresh_token: refreshToken,
      access_token: accessToken,
      access_token_expires_at: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id" });
    if (secErr) throw new Error(`could not store the tokens: ${secErr.message}`);

    const watch = await registerWatch(admin, cfg, account, accessToken);

    // Prime the link immediately: a "connected" that shows an empty calendar
    // until some cron fires is indistinguishable from a broken one.
    const { error: jobErr } = await admin.from("calendar_sync_jobs")
      .insert({ user_id: account.user_id, account_id: account.id, reason: "reconnect" });
    if (jobErr && jobErr.code !== "23505") console.error(`could not enqueue first sync: ${jobErr.message}`);

    return redirectWith(target, {
      gcal: "connected",
      account: email || "(unknown account)",
      calendar: cal.summary,
      note: watch.ok ? cal.note : `${cal.note}; live updates unavailable (${watch.reason}) - syncing every 5 minutes instead`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(target, { gcal: "error", reason: message.slice(0, 400) });
  }
}

async function actionWebhook(req: Request): Promise<Response> {
  // Google's webhook carries NO event data and expects a fast 200. Anything slow
  // here gets retried, and a channel that keeps failing gets dropped - which is
  // how live updates stop without anybody being told.
  const channelId = req.headers.get("x-goog-channel-id") || "";
  const channelToken = req.headers.get("x-goog-channel-token") || "";
  const resourceState = req.headers.get("x-goog-resource-state") || "";
  const messageNumber = Number(req.headers.get("x-goog-message-number") || "0");

  if (!channelId) return new Response("missing channel id", { status: 400 });

  const admin = adminClient();
  const { data: account, error } = await admin.from("calendar_accounts")
    .select("id, user_id").eq("channel_id", channelId).maybeSingle();
  if (error) {
    console.error(`webhook account lookup failed: ${error.message}`);
    return new Response("lookup failed", { status: 500 });
  }
  // An unknown channel is a stale one Google has not stopped sending on yet.
  // 200 so it is not retried forever; 404 would keep the retries coming.
  if (!account) return new Response("unknown channel", { status: 200 });

  const { data: secret, error: secErr } = await admin.from("calendar_secrets")
    .select("channel_token").eq("account_id", account.id).maybeSingle();
  if (secErr) {
    console.error(`webhook token lookup failed: ${secErr.message}`);
    return new Response("lookup failed", { status: 500 });
  }
  if (!secret?.channel_token || !safeEqual(channelToken, secret.channel_token)) {
    // The address is public. The token is the only thing proving this POST came
    // from the channel we registered.
    return new Response("bad channel token", { status: 401 });
  }

  // `sync` is Google's "channel created" handshake, not a change.
  if (resourceState === "sync") return new Response("ok", { status: 200 });

  const { error: jobErr } = await admin.from("calendar_sync_jobs").insert({
    user_id: account.user_id,
    account_id: account.id,
    reason: "webhook",
    resource_state: resourceState,
    message_number: Number.isFinite(messageNumber) ? messageNumber : null,
  });
  // 23505 = a pending job already exists. A burst of edits collapses to one job:
  // the unique violation IS the success case, exactly like reminder_fires.
  if (jobErr && jobErr.code !== "23505") {
    console.error(`could not enqueue sync job: ${jobErr.message}`);
    return new Response("enqueue failed", { status: 500 });
  }
  return new Response("ok", { status: 200 });
}

async function actionDrain(admin: any, cfg: GoogleConfig) {
  if (!cfg.configured) return notConfigured(cfg);
  const results: any[] = [];

  const { data: jobs, error } = await admin.rpc("claim_calendar_sync_jobs", { p_limit: 10 });
  if (error) return { ok: false, error: `could not claim sync jobs: ${error.message}` };

  const seen = new Set<string>();
  for (const job of jobs || []) {
    seen.add(String(job.account_id));
    const { data: account } = await admin.from("calendar_accounts").select("*").eq("id", job.account_id).maybeSingle();
    if (!account) {
      await admin.from("calendar_sync_jobs").update({ status: "failed", error: "account is gone", finished_at: new Date().toISOString() }).eq("id", job.id);
      continue;
    }
    const result = await syncAccount(admin, cfg, account);
    results.push({ jobId: job.id, ...result });
    await admin.from("calendar_sync_jobs").update({
      status: result.ok ? "done" : "failed",
      error: result.ok ? null : String((result as any).error || "").slice(0, 500),
      finished_at: new Date().toISOString(),
    }).eq("id", job.id);
  }

  // THE SAFETY NET. A push channel can die without telling anyone (an expired
  // channel, a dropped renewal, a webhook we 500'd on). Polling anything stale
  // is what keeps a dead channel from turning into a dead calendar.
  const staleBefore = new Date(Date.now() - POLL_IF_STALE_MS).toISOString();
  const { data: stale, error: staleErr } = await admin.from("calendar_accounts")
    .select("*").eq("status", "connected")
    .or(`last_sync_at.is.null,last_sync_at.lt.${staleBefore}`).limit(10);
  if (staleErr) results.push({ ok: false, error: `stale scan failed: ${staleErr.message}` });
  for (const account of stale || []) {
    if (seen.has(String(account.id))) continue;
    results.push({ polled: true, ...(await syncAccount(admin, cfg, account)) });
  }

  return { ok: true, action: "drain", jobs: (jobs || []).length, results };
}

async function actionRenew(admin: any, cfg: GoogleConfig) {
  if (!cfg.configured) return notConfigured(cfg);
  const cutoff = new Date(Date.now() + CHANNEL_RENEW_WITHIN_MS).toISOString();
  const { data: accounts, error } = await admin.from("calendar_accounts")
    .select("*").eq("status", "connected")
    .or(`channel_expiry.is.null,channel_expiry.lt.${cutoff}`);
  if (error) return { ok: false, error: `renew scan failed: ${error.message}` };

  const results: any[] = [];
  for (const account of accounts || []) {
    try {
      const token = await accessTokenFor(admin, cfg, account.id);
      // Stop the old channel first, or Google keeps delivering on both and the
      // account accumulates channels it can never clean up.
      if (account.channel_id && account.channel_resource_id) {
        const stopped = await stopWatch(cfg, token, account.channel_id, account.channel_resource_id);
        if (!stopped.ok) console.error(`could not stop channel for ${account.id}: ${stopped.reason}`);
      }
      const watch = await registerWatch(admin, cfg, account, token);
      results.push({ accountId: account.id, renewed: watch.ok, reason: watch.reason });
      if (!watch.ok) console.error(`watch renewal failed for ${account.id}: ${watch.reason}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markBroken(admin, account.id, `channel renewal failed: ${message}`, gcIsAuthFailure(0, message));
      results.push({ accountId: account.id, renewed: false, reason: message });
    }
  }
  return { ok: true, action: "renew", checked: (accounts || []).length, results };
}

async function actionStatus(admin: any, cfg: GoogleConfig, userId: string) {
  const { data: accounts, error } = await admin.from("calendar_accounts")
    // Never `select("*")` here: this response goes to a browser, and the row
    // must not grow a secret-shaped column later and start shipping it.
    .select("id, provider, external_account_email, calendar_id, calendar_summary, status, scopes, channel_expiry, last_sync_at, last_push_at, last_full_sync_at, sync_broken_since, sync_broken_reason, created_at")
    .eq("user_id", userId).order("created_at", { ascending: true });
  if (error) return { ok: false, error: `could not read connected calendars: ${error.message}` };

  const out: any[] = [];
  for (const account of accounts || []) {
    const { count: linkCount, error: linkErr } = await admin.from("calendar_links")
      .select("id", { count: "exact", head: true }).eq("account_id", account.id);
    const { count: mirrorCount, error: mirrorErr } = await admin.from("calendar_events_raw")
      .select("id", { count: "exact", head: true }).eq("account_id", account.id).is("tombstoned_at", null);
    const { count: pendingCount } = await admin.from("calendar_sync_jobs")
      .select("id", { count: "exact", head: true }).eq("account_id", account.id).eq("status", "pending");
    out.push({
      ...account,
      linked_events: linkErr ? null : linkCount,
      mirrored_events: mirrorErr ? null : mirrorCount,
      pending_jobs: pendingCount ?? null,
      // Counting failures are reported, not defaulted to 0: "0 events synced"
      // and "we could not count them" must never render identically.
      count_errors: [linkErr?.message, mirrorErr?.message].filter(Boolean),
      can_mirror: Array.isArray(account.scopes) && account.scopes.some((s: string) => String(s).includes("calendar.events.readonly")),
    });
  }

  return {
    ok: true,
    configured: cfg.configured,
    missing_secrets: cfg.missing,
    message: cfg.configured ? "" : notConfigured(cfg).message,
    redirect_uri: cfg.redirectUri,
    webhook_url: cfg.webhookUrl,
    accounts: out,
  };
}

async function actionDisconnect(admin: any, cfg: GoogleConfig, userId: string, payload: any) {
  const accountId = String(payload?.account_id || "");
  if (!accountId) return { ok: false, error: "account_id is required" };
  const { data: account, error } = await admin.from("calendar_accounts")
    .select("*").eq("id", accountId).eq("user_id", userId).maybeSingle();
  if (error) return { ok: false, error: `account read failed: ${error.message}` };
  if (!account) return { ok: false, error: "no such connected calendar" };

  const notes: string[] = [];
  if (cfg.configured) {
    try {
      const token = await accessTokenFor(admin, cfg, account.id);
      if (account.channel_id && account.channel_resource_id) {
        const stopped = await stopWatch(cfg, token, account.channel_id, account.channel_resource_id);
        if (!stopped.ok) notes.push(stopped.reason);
      }
      const { data: secret } = await admin.from("calendar_secrets").select("refresh_token").eq("account_id", account.id).maybeSingle();
      if (secret?.refresh_token) {
        const res = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(secret.refresh_token)}`, { method: "POST" });
        if (!res.ok) notes.push(`Google did not accept the revoke (${res.status}); remove it at myaccount.google.com/permissions`);
      }
    } catch (err) {
      notes.push(`could not revoke cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // The row goes either way. A "disconnect" that leaves a token behind because
  // Google was unreachable is the worst of both worlds.
  const { error: delErr } = await admin.from("calendar_accounts").delete().eq("id", account.id);
  if (delErr) return { ok: false, error: `could not remove the account: ${delErr.message}`, notes };
  return { ok: true, disconnected: account.external_account_email || account.id, notes };
}

// -------- handler --------

const USER_ACTIONS = ["auth_url", "status", "pull", "push", "sync", "disconnect"];
const CRON_ACTIONS = ["drain", "renew", "sync"];

Deno.serve(async (req) => {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-jarvis-secret",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const sub = url.pathname.replace(/^.*\/gcal\/?/, "").replace(/\/+$/, "");

  // Google's two unauthenticated entry points. Both are routed BEFORE the auth
  // block, because neither carries a JWT and neither ever can.
  if (sub === "callback") return await actionCallback(req);
  if (sub === "webhook") return await actionWebhook(req);

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const payload = await req.json().catch(() => ({}));
    const action = String(payload?.action || "");
    const admin = adminClient();
    const cfg = await googleConfig();

    // Auth: the cron secret runs the account-wide jobs; a user JWT runs only
    // that user. Same posture as the jarvis function.
    const cronSecret = await resolveSecretOptional("JARVIS_CRON_SECRET");
    const headerSecret = req.headers.get("x-jarvis-secret") || "";
    const isCron = Boolean(cronSecret && headerSecret && safeEqual(headerSecret, cronSecret));

    if (isCron) {
      if (!CRON_ACTIONS.includes(action)) {
        return Response.json({ ok: false, error: "unknown_action", allowed: CRON_ACTIONS }, { status: 400, headers: corsHeaders });
      }
      if (action === "drain") return Response.json(await actionDrain(admin, cfg), { headers: corsHeaders });
      if (action === "renew") return Response.json(await actionRenew(admin, cfg), { headers: corsHeaders });
      // action === "sync": every connected account, used by the heartbeat.
      if (!cfg.configured) return Response.json(notConfigured(cfg), { headers: corsHeaders });
      const { data: accounts, error } = await admin.from("calendar_accounts").select("*").eq("status", "connected");
      if (error) return Response.json({ ok: false, error: `account scan failed: ${error.message}` }, { status: 500, headers: corsHeaders });
      const results = [];
      for (const account of accounts || []) results.push(await syncAccount(admin, cfg, account));
      return Response.json({ ok: true, action, accounts: (accounts || []).length, results }, { headers: corsHeaders });
    }

    if (!USER_ACTIONS.includes(action)) {
      return Response.json({ ok: false, error: "unknown_action", allowed: USER_ACTIONS }, { status: 400, headers: corsHeaders });
    }

    const auth = req.headers.get("authorization") || "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!jwt) return Response.json({ ok: false, error: "missing_auth" }, { status: 401, headers: corsHeaders });
    const { data: userResp, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userResp?.user?.id) {
      return Response.json({ ok: false, error: "invalid_auth" }, { status: 401, headers: corsHeaders });
    }
    const userId = userResp.user.id;

    // `status` answers even when nothing is configured - that IS the answer the
    // panel needs in order to say what is missing.
    if (action === "status") return Response.json(await actionStatus(admin, cfg, userId), { headers: corsHeaders });
    if (action === "auth_url") return Response.json(await actionAuthUrl(admin, cfg, userId, payload), { headers: corsHeaders });
    if (action === "disconnect") return Response.json(await actionDisconnect(admin, cfg, userId, payload), { headers: corsHeaders });

    if (!cfg.configured) return Response.json(notConfigured(cfg), { headers: corsHeaders });

    const { data: accounts, error } = await admin.from("calendar_accounts")
      .select("*").eq("user_id", userId).eq("status", "connected");
    if (error) return Response.json({ ok: false, error: `account read failed: ${error.message}` }, { status: 500, headers: corsHeaders });
    if (!accounts || !accounts.length) {
      return Response.json({ ok: false, error: "no_account", message: "No Google Calendar is connected to this account yet." }, { headers: corsHeaders });
    }

    const results: any[] = [];
    for (const account of accounts) {
      if (action === "pull") {
        try {
          results.push({ ok: true, ...(await pullAccount(admin, cfg, account)) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await markBroken(admin, account.id, message, gcIsAuthFailure(0, message));
          results.push({ ok: false, accountId: account.id, error: message });
        }
      } else if (action === "push") {
        try {
          results.push({ ok: true, ...(await pushAccount(admin, cfg, account)) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await markBroken(admin, account.id, message, gcIsAuthFailure(0, message));
          results.push({ ok: false, accountId: account.id, error: message });
        }
      } else {
        results.push(await syncAccount(admin, cfg, account));
      }
    }
    return Response.json({ ok: true, action, accounts: accounts.length, results }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
