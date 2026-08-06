// deno-lint-ignore-file no-explicit-any
// Deno (the app) - the proactive engine, still slugged `jarvis` internally.
// The "Deno" in Deno.serve below is the edge RUNTIME, unrelated to the app name.
//
// pg_cron → jarvis_ping() → pg_net POSTs here three times a day (see
// 20260706000015_jarvis_engine.sql):
//   closeout 00:05 IST - close the just-ended local day into habit_days (+ streaks),
//            write a `closeout` briefing, and on Sundays the weekly_reviews row.
//   morning  07:00 IST - compose the facts JSON, let DeepSeek-chat narrate it
//            (Gemini fallback, deterministic fallback below that), persist the
//            `morning` briefing, deliver via Resend email + Web Push.
//   evening  20:30 IST - nudge on what is still fixable today; push only
//            (email only when actionable).
//
// Auth: `x-jarvis-secret` header matching app_secrets JARVIS_CRON_SECRET runs all
// enabled users (the cron path); a user JWT runs just that user ("Brief me now").
// Deployed with verify_jwt=false - auth is enforced in-function because the
// publishable/new-style API keys are not JWTs.
//
// The voice model NEVER invents figures: it is prompted to copy numbers verbatim
// from the facts JSON, and the deterministic fallback (jbMorningFallback) is the
// contract of record. LLM spend is logged to ai_runs (purpose 'jarvis_voice') so
// the agent's daily cost cap covers Jarvis too.

import { createClient } from "npm:@supabase/supabase-js@2.74.0";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const GEMINI_MODEL = "gemini-2.5-flash";
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// Same pricing table as the agent fn (cost meter only) - and it carried the same
// stale Gemini card: 0.075/0.3 is roughly a quarter of Gemini 2.5 Flash's real
// 0.30/2.50, so a Gemini-voiced brief was billed against DAILY_COST_CAP_USD at a
// quarter of what it costs. Keep these two lines identical to the agent function's.
const GEMINI_IN_USD = 0.3, GEMINI_OUT_USD = 2.5;
const DEEPSEEK_IN_USD = 0.55, DEEPSEEK_OUT_USD = 2.2;
const DAILY_COST_CAP_USD = 2;

// ==== AUTONOMY GOVERNANCE ====================================================
// The constants a self-triggering agent runs under. Kept byte-comparable with
// lib/agent-tasks.mjs, which is the browser/test copy - tests/agent-tasks.test.mjs
// extracts these literals from THIS source and asserts they match, the same
// anti-drift trick tests/mirror-parity.test.mjs uses for the lexicons. (They are
// not a sync-mirror block because scripts/sync-mirror.mjs is owned elsewhere.)
//
// Why any of this exists: AUTO_APPLY_MIN_CONFIDENCE is 0 in the agent function,
// so every tool call commits immediately. That is defensible when a human just
// typed the capture and is watching the feed. At 03:00, with a model deciding on
// its own what to emit and nobody watching, it is not.
const AUTONOMOUS_TOOLS = ["answer_question", "create_note_candidate", "request_user_review"];
const TASK_INTENTS = ["check", "answer", "remind", "review"];
const AUTONOMY_MAX_DEPTH = 1;            // a task may not create a task
const AUTONOMY_RATE_WINDOW_MIN = 5;
const AUTONOMY_RATE_MAX = 6;             // vs the human's 60/5min, on a SEPARATE ledger
const AUTONOMY_DAILY_COST_USD = 0.25;    // vs the human's $2/day, likewise separate
const AUTONOMY_MAX_FAILURES = 3;         // visible circuit breaker
const AUTONOMY_LOOP_REPEATS = 3;         // same (task, actions) 3x in 24h = a loop
const AUTONOMY_LOOP_WINDOW_H = 24;
const AUTONOMY_MAX_PER_TICK = 5;

// -------- env / clients (mirrors agent/index.ts) --------

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
  try { return await resolveSecret(name); } catch { return null; }
}
async function resolveAnySecret(names: string[]): Promise<string | null> {
  for (const n of names) { const v = await resolveSecretOptional(n); if (v) return v; }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let out = 0;
  for (let i = 0; i < ea.length; i++) out |= ea[i] ^ eb[i];
  return out === 0;
}

// ==== REMINDERS MIRROR START (byte-identical in lib/reminders.mjs) ====
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
    const span = Math.min(720, step * 6 + 24);
    for (let i = 0; i < span; i++, idx++) {
      if ((idx - anchorIdx) % step !== 0) continue;
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
  const cap = Math.min(n, 400);
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
    base = months.length > 1
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

// ==== JARVIS-BRIEF MIRROR START (byte-identical in lib/jarvis-brief.mjs) ====
function jbRound(n) { return Math.round(Number(n) || 0); }

function jbRupees(n) { return "Rs " + jbRound(n).toLocaleString("en-IN"); }

function jbTzOffsetMinutes(instant, timeZone) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  var parts = {};
  var ps = dtf.formatToParts(instant);
  for (var i = 0; i < ps.length; i++) parts[ps[i].type] = ps[i].value;
  var asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === "24" ? 0 : parts.hour), Number(parts.minute), Number(parts.second),
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

// Civil "YYYY-MM-DD" for an instant in a timezone (en-CA formats ISO-style).
function jbDateKeyInTz(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

// UTC instants [startISO, endISO) covering one civil day in a timezone.
function jbDayWindow(dateKey, timeZone) {
  var guess = new Date(dateKey + "T00:00:00Z");
  var off = jbTzOffsetMinutes(guess, timeZone);
  var start = new Date(guess.getTime() - off * 60000);
  var off2 = jbTzOffsetMinutes(start, timeZone);
  if (off2 !== off) start = new Date(guess.getTime() - off2 * 60000);
  return { startISO: start.toISOString(), endISO: new Date(start.getTime() + 86400000).toISOString() };
}

function jbAddDays(dateKey, delta) {
  var d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ISO weekday 1=Mon … 7=Sun for a civil date key.
function jbWeekdayFromKey(dateKey) {
  var d = new Date(dateKey + "T00:00:00Z");
  return ((d.getUTCDay() + 6) % 7) + 1;
}

// Days left in the key's month, including the key's day itself.
function jbDaysLeftInMonth(dateKey) {
  var y = Number(dateKey.slice(0, 4)), m = Number(dateKey.slice(5, 7)), d = Number(dateKey.slice(8, 10));
  var daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.max(1, daysInMonth - d + 1);
}

function jbMinutesOfDay(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Quiet hours in the user's local time; a window may wrap past midnight.
function jbInQuietHours(instant, timeZone, quiet) {
  if (!quiet) return false;
  var s = jbMinutesOfDay(quiet.start), e = jbMinutesOfDay(quiet.end);
  if (s == null || e == null || s === e) return false;
  var hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(instant);
  var mins = jbMinutesOfDay(hm);
  if (mins == null) return false;
  return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

// Standing scaffold names, mirrored from lib/diet-scaffold.mjs (labels only -
// the brief needs the day's headline, not the meal list). Keep in sync by hand.
var JB_WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
var JB_WORKOUT_BY_WEEKDAY = { 1: "A", 2: "cardio", 3: "cardio", 4: "cardio", 5: "B", 6: "A", 7: "B" };
var JB_WORKOUTS = {
  A: { name: "Workout A", kind: "gym" },
  B: { name: "Workout B", kind: "gym" },
  cardio: { name: "Cardio - forgiven day", kind: "cardio" },
};

function jbDietLabelForWeekday(wd) {
  return (wd === 3 || wd === 6) ? "Paneer-Soy day" : "Soybean day";
}

// Resolve the planned workout for a weekday: a permanent user_plans gym payload
// (flat spec or {days:{Mon:…}} map) wins; otherwise the standing scaffold cycle.
function jbPlannedWorkout(wd, gymPayload) {
  if (gymPayload && typeof gymPayload === "object" && !Array.isArray(gymPayload)) {
    var spec = gymPayload;
    if (gymPayload.days && typeof gymPayload.days === "object") {
      var short = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd];
      spec = gymPayload.days[short] || gymPayload.days[JB_WEEKDAY_NAMES[wd]] || null;
    }
    if (spec && (spec.name || spec.kind)) {
      return { name: spec.name || "Custom workout", kind: spec.kind || "gym" };
    }
  }
  return JB_WORKOUTS[JB_WORKOUT_BY_WEEKDAY[wd]];
}

function jbBudgetAmount(budgets, kind) {
  var rows = budgets || [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].kind === kind && rows[i].amount != null) return Number(rows[i].amount);
  }
  return null;
}

// Daily spend cap derived the same way src/services/briefing.js does it.
function jbDailySpendCap(budgets) {
  var monthly = jbBudgetAmount(budgets, "monthly_spend");
  if (monthly != null) return Math.round(monthly / 30);
  var weekly = jbBudgetAmount(budgets, "weekly_spend");
  if (weekly != null) return Math.round(weekly / 7);
  return null;
}

// Close one civil day from its raw rows. plannedKind: "gym" | "cardio" | "rest".
function jbCloseDay(input) {
  var ledger = input.ledger || [], foods = input.foods || [], workouts = input.workouts || [];
  var wellness = input.wellness || [], bodyMetrics = input.bodyMetrics || [], budgets = input.budgets || [];
  var plannedKind = input.plannedKind || "gym";

  var spend = 0, discretionarySpend = 0, income = 0;
  for (var i = 0; i < ledger.length; i++) {
    var e = ledger[i], amt = Number(e.amount) || 0;
    if (e.direction === "expense") { spend += amt; if (e.is_discretionary) discretionarySpend += amt; }
    else if (e.direction === "income") income += amt;
  }

  var protein = 0, calories = 0;
  for (var f = 0; f < foods.length; f++) {
    protein += Number(foods[f].protein_g) || 0;
    calories += Number(foods[f].calories_estimate) || 0;
  }

  // A 'skipped'/'rest' row records that the user answered the day ("no gym
  // today") - it is NOT training. Counting every row is what turned "Did not go
  // to gym bro" into a completed workout and a rolling gym streak. Rows written
  // before the status column existed have no status and stay 'done'.
  var realWorkouts = [];
  for (var rw = 0; rw < workouts.length; rw++) {
    var st = workouts[rw] && workouts[rw].status;
    if (st === "skipped" || st === "rest") continue;
    realWorkouts.push(workouts[rw]);
  }

  var workoutMin = 0;
  for (var w = 0; w < realWorkouts.length; w++) workoutMin += Number(realWorkouts[w].duration_min) || 0;

  // sleepH stays NULL when nothing was measured. It used to default to 0, which
  // the voice model then narrated as the fact "you got zero sleep" every single
  // day - a number the app had never collected.
  var steps = 0, sleepH = null, weightKg = null;
  for (var b = 0; b < bodyMetrics.length; b++) {
    var m = bodyMetrics[b], v = Number(m.value) || 0;
    if (m.metric_type === "steps" && v > steps) steps = v;
    else if (m.metric_type === "sleep_hours" && v > 0 && v > (sleepH || 0)) sleepH = v;
    else if (m.metric_type === "weight" && v > 0) weightKg = v;
  }
  // Completed sleep_sessions are the primary source; body_metrics is the legacy one.
  var sessions = input.sleepSessions || [];
  var sessionH = 0;
  for (var sx = 0; sx < sessions.length; sx++) {
    var s0 = sessions[sx];
    if (!s0 || !s0.started_at || !s0.ended_at) continue;
    var hrs = (new Date(s0.ended_at).getTime() - new Date(s0.started_at).getTime()) / 3600000;
    if (hrs > 0 && hrs < 24) sessionH += hrs;
  }
  if (sessionH > 0) sleepH = sessionH;
  sleepH = sleepH == null ? null : Math.round(sleepH * 10) / 10;

  var moodSum = 0, moodN = 0;
  for (var q = 0; q < wellness.length; q++) {
    var mood = Number(wellness[q].mood_score);
    if (mood > 0) { moodSum += mood; moodN++; }
  }

  var proteinTarget = jbBudgetAmount(budgets, "daily_protein");
  var caloriesTarget = jbBudgetAmount(budgets, "daily_calories");
  var spendCap = jbDailySpendCap(budgets);

  // `logged` counts ALL rows including a skipped workout - declining the gym is
  // still answering the day, and the logging streak should survive it.
  var logged = (ledger.length + foods.length + workouts.length + wellness.length + bodyMetrics.length + sessions.length) > 0;
  // A forgiven-cardio day counts on 10k steps OR any real session; rest days always count.
  var workoutDone = realWorkouts.length > 0 || steps >= 10000;
  var workoutForgiven = !workoutDone && plannedKind === "rest";
  var flags = {
    logged: logged,
    workout: workoutDone,
    workout_forgiven: workoutForgiven,
    workout_ok: workoutDone || workoutForgiven,
    protein_hit: proteinTarget != null && proteinTarget > 0 && protein >= proteinTarget * 0.9,
    // A day with NOTHING logged is not a day under budget. Counting it grew the
    // budget streak on days the user never opened the app.
    under_budget: spendCap != null && logged && spend <= spendCap,
  };

  return {
    spend: Math.round(spend), discretionarySpend: Math.round(discretionarySpend), income: Math.round(income),
    protein: Math.round(protein), calories: Math.round(calories), meals: foods.length,
    workoutDone: workoutDone, workoutMin: Math.round(workoutMin),
    steps: steps, sleepH: sleepH, weightKg: weightKg,
    moodAvg: moodN ? Math.round((moodSum / moodN) * 10) / 10 : null,
    logged: logged,
    caps: { spendCap: spendCap, proteinTarget: proteinTarget, caloriesTarget: caloriesTarget },
    flags: flags,
  };
}

// Streaks roll forward from the previous day's row; a miss resets to 0.
function jbNextStreaks(prev, flags) {
  var p = prev || {};
  var f = flags || {};
  return {
    workout: f.workout_ok ? (Number(p.workout) || 0) + 1 : 0,
    protein: f.protein_hit ? (Number(p.protein) || 0) + 1 : 0,
    budget: f.under_budget ? (Number(p.budget) || 0) + 1 : 0,
    logging: f.logged ? (Number(p.logging) || 0) + 1 : 0,
  };
}

function jbSafeToSpend(o) {
  var cap = Number(o.monthlyCap) || 0;
  if (cap <= 0) return { hasBudget: false };
  var remaining = cap - (Number(o.monthSpend) || 0) - (Number(o.subsDueTotal) || 0);
  var daysLeft = Math.max(1, Number(o.daysLeft) || 1);
  return { hasBudget: true, monthlyCap: cap, remaining: Math.round(remaining), daysLeft: daysLeft, perDay: Math.round(remaining / daysLeft) };
}

// Assemble the morning facts object - the ONLY numbers the voice model may use.
function jbBriefFacts(o) {
  var wd = jbWeekdayFromKey(o.dateKey);
  var workout = jbPlannedWorkout(wd, o.gymPayload);
  var y = o.yesterday || null;
  var subsDue = o.subsDue || [];
  var subsDueTotal = 0;
  for (var i = 0; i < subsDue.length; i++) subsDueTotal += Number(subsDue[i].amount) || 0;
  return {
    for_date: o.dateKey,
    weekday: JB_WEEKDAY_NAMES[wd],
    diet_label: jbDietLabelForWeekday(wd),
    workout: { name: workout.name, kind: workout.kind },
    targets: {
      protein_g: jbBudgetAmount(o.budgets, "daily_protein"),
      calories: jbBudgetAmount(o.budgets, "daily_calories"),
      spend_cap: jbDailySpendCap(o.budgets),
    },
    yesterday: y ? {
      spend: y.spend, protein: y.protein, calories: y.calories,
      // workout_done means a session actually happened. It used to carry
      // workout_ok, so a rest/forgiven day with zero training was narrated as
      // "workout done". Both are exposed now, distinctly.
      workout_done: y.flags ? Boolean(y.flags.workout) : Boolean(y.workoutDone),
      workout_ok: y.flags ? Boolean(y.flags.workout_ok) : Boolean(y.workoutDone),
      // null (not false) when no target/cap exists - "no target" must never be
      // narrated as "missed"/"over".
      protein_hit: (y.caps && y.caps.proteinTarget != null && y.caps.proteinTarget > 0)
        ? Boolean(y.flags && y.flags.protein_hit) : null,
      under_budget: (y.caps && y.caps.spendCap != null)
        ? Boolean(y.flags && y.flags.under_budget) : null,
      sleep_h: y.sleepH, weight_kg: y.weightKg, logged_anything: y.logged,
    } : null,
    streaks: o.streaks || {},
    money: jbSafeToSpend({
      monthlyCap: jbBudgetAmount(o.budgets, "monthly_spend"),
      monthSpend: o.monthSpend, daysLeft: jbDaysLeftInMonth(o.dateKey), subsDueTotal: subsDueTotal,
    }),
    subs_due: subsDue,
    // Calendar reminders due today or inside their own lead window. Titles and
    // dates only - the voice model may phrase them but the brief also appends
    // them deterministically, because a missed filing must not depend on the
    // model having chosen to mention it.
    reminders_due: (o.remindersDue || []).map(function (r) {
      return { title: r.title, kind: r.kind, due_on: r.next_due_on, days_away: r.days_away };
    }),
    weekly_workouts: { done: Number(o.weeklyWorkouts) || 0, target: jbBudgetAmount(o.budgets, "weekly_workouts") },
  };
}

// Deterministic morning brief - the always-works voice the LLM only embellishes.
function jbMorningFallback(facts) {
  var lines = [];
  lines.push("Good morning - " + facts.weekday + ", " + facts.diet_label + ".");
  var y = facts.yesterday;
  if (y && y.logged_anything) {
    var ybits = [jbRupees(y.spend) + " spent"];
    if (y.protein > 0) ybits.push(y.protein + "g protein" + (y.protein_hit ? " (hit)" : ""));
    ybits.push(y.workout_done ? "workout done" : "no workout");
    if (y.sleep_h > 0) ybits.push("slept " + y.sleep_h + "h");
    lines.push("Yesterday: " + ybits.join(", ") + ".");
  }
  var t = [];
  if (facts.workout && facts.workout.name) t.push(facts.workout.name);
  if (facts.targets.protein_g) t.push(jbRound(facts.targets.protein_g) + "g protein");
  if (facts.targets.calories) t.push(jbRound(facts.targets.calories) + " kcal");
  if (t.length) lines.push("Today: " + t.join(", ") + ".");
  if (facts.money && facts.money.hasBudget) {
    lines.push("Safe to spend: " + jbRupees(facts.money.perDay) + "/day (" + jbRupees(facts.money.remaining) + " left over " + facts.money.daysLeft + "d).");
  }
  for (var i = 0; i < (facts.subs_due || []).length && i < 2; i++) {
    var s = facts.subs_due[i];
    lines.push(s.merchant + " " + jbRupees(s.amount) + " expected in " + s.in_days + "d.");
  }
  var st = facts.streaks || {}, sbits = [];
  if (st.workout > 1) sbits.push("gym " + st.workout + "d");
  if (st.protein > 1) sbits.push("protein " + st.protein + "d");
  if (st.budget > 1) sbits.push("budget " + st.budget + "d");
  if (sbits.length) lines.push("Streaks: " + sbits.join(" · ") + ".");
  return lines.join(" ");
}

// Evening nudge - only what is still fixable today.
function jbEveningBody(s) {
  var nudges = [];
  var pt = jbRound(s.proteinTarget), p = jbRound(s.proteinToday);
  if (pt > 0 && pt - p > 10) nudges.push((pt - p) + "g protein to go");
  var ct = jbRound(s.caloriesTarget), c = jbRound(s.caloriesToday);
  if (ct > 0 && c - ct > 50) nudges.push((c - ct) + " kcal over target");
  if (s.plannedKind && s.plannedKind !== "rest" && !s.workoutLogged) {
    nudges.push("gym not logged yet (" + (s.plannedName || "workout") + ")");
  }
  if (s.spendCap != null && jbRound(s.todaySpend) > jbRound(s.spendCap)) {
    nudges.push("over today's spend by " + jbRupees(jbRound(s.todaySpend) - jbRound(s.spendCap)));
  }
  var headline = nudges.length ? "Evening check-in - still time" : "Evening check-in - on track";
  var body = nudges.length ? headline + ": " + nudges.join(" · ") + "." : headline + ". Nothing left undone.";
  return { headline: headline, nudges: nudges, body: body };
}

// Midday pace check (deterministic).
//
// The evening nudge at 20:30 arrives after the day is effectively decided: the
// owner averages 87g of protein against a 151-162g target, and by 20:30 there is
// one meal left to find 75g in. This fires early enough to still act on, and
// stays silent unless it has something concrete to say - a notification that
// says "on track" every day is how a person learns to swipe them away.
//
// Everything here is a real measurement or nothing. `proteinToday` of 0 with
// `mealsLogged` of 0 means NOT YET LOGGED, which is a different sentence from
// "you have eaten nothing".
function jbMiddayBody(s) {
  var nudges = [];
  var pt = jbRound(s.proteinTarget), p = jbRound(s.proteinToday);
  var meals = Number(s.mealsLogged || 0);
  var hoursLeft = Number(s.hoursLeftInDay);

  if (meals === 0) {
    nudges.push("nothing logged yet today");
  } else if (pt > 0) {
    var gap = pt - p;
    // Pace, not the raw gap: being 60g short at 14:00 is fine, being 60g short
    // with two hours of eating left is not.
    if (gap > 25) nudges.push(p + " / " + pt + "g protein - " + gap + "g to find");
  }

  var ct = jbRound(s.caloriesTarget), c = jbRound(s.caloriesToday);
  if (ct > 0 && c > ct) nudges.push(c - ct + " kcal over already");

  if (s.plannedKind && s.plannedKind !== "rest" && !s.workoutLogged && hoursLeft > 3) {
    nudges.push((s.plannedName || "workout") + " still to do");
  }

  if (s.spendCap != null && jbRound(s.todaySpend) > jbRound(s.spendCap)) {
    nudges.push("over today's spend by " + jbRupees(jbRound(s.todaySpend) - jbRound(s.spendCap)));
  }

  // One concrete move, drawn from the biggest gap rather than a generic cheer.
  var move = null;
  if (meals === 0) move = "Log what you have eaten so far.";
  else if (pt > 0 && pt - p > 40) move = "A 500ml curd plus a whey scoop is about 55g.";
  else if (pt > 0 && pt - p > 25) move = "Six boiled eggs is about 38g.";

  var headline = nudges.length ? "Midday check" : null;
  var body = nudges.length
    ? "Midday: " + nudges.join(" · ") + "." + (move ? " " + move : "")
    : null;
  return { headline: headline, nudges: nudges, body: body, move: move };
}

// Nightly close-out body (deterministic; no LLM at midnight).
function jbCloseoutBody(day, streaks) {
  var bits = [];
  bits.push(jbRupees(day.spend) + " spent" + (day.caps.spendCap != null ? (day.flags.under_budget ? " (under cap)" : " (over cap)") : ""));
  if (day.caps.proteinTarget != null && day.caps.proteinTarget > 0) {
    bits.push(day.protein + "g protein" + (day.flags.protein_hit ? " (hit)" : " (short)"));
  }
  bits.push(day.workoutDone ? "workout done" : (day.flags.workout_forgiven ? "rest day" : "no workout"));
  if (day.sleepH > 0) bits.push("slept " + day.sleepH + "h");
  var st = streaks || {}, sbits = [];
  if (st.workout > 1) sbits.push("gym " + st.workout + "d");
  if (st.protein > 1) sbits.push("protein " + st.protein + "d");
  if (st.budget > 1) sbits.push("budget " + st.budget + "d");
  return "Day closed: " + bits.join(", ") + "." + (sbits.length ? " Streaks: " + sbits.join(" · ") + "." : "");
}

// Aggregate a week of habit_days rows into weekly_reviews.summary.
function jbWeeklySummary(days) {
  var rows = days || [];
  var t = { spend: 0, protein: 0, calories: 0, sleep: 0, sleepN: 0 };
  var hits = { workout_days: 0, protein_days: 0, budget_days: 0, logged_days: 0 };
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].summary || {}, f = rows[i].flags || {};
    t.spend += Number(s.spend) || 0;
    t.protein += Number(s.protein) || 0;
    t.calories += Number(s.calories) || 0;
    if (Number(s.sleepH) > 0) { t.sleep += Number(s.sleepH); t.sleepN++; }
    if (f.workout_ok) hits.workout_days++;
    if (f.protein_hit) hits.protein_days++;
    if (f.under_budget) hits.budget_days++;
    if (f.logged) hits.logged_days++;
  }
  var n = rows.length;
  return {
    days: n,
    totals: { spend: Math.round(t.spend), workouts: hits.workout_days },
    averages: {
      protein: n ? Math.round(t.protein / n) : 0,
      calories: n ? Math.round(t.calories / n) : 0,
      // null, not 0 - "no sleep was recorded this week" is not "you slept 0h".
      sleep_h: t.sleepN ? Math.round((t.sleep / t.sleepN) * 10) / 10 : null,
    },
    hits: hits,
    end_streaks: n ? (rows[n - 1].streaks || {}) : {},
  };
}

// Voice contract: the model phrases, the facts JSON owns every number.
var JB_VOICE_SYSTEM = "You are Jarvis, the user's personal chief of staff inside their life tracker. Write their morning brief from the facts JSON: 3 to 6 short sentences, direct address, brisk and warm, plain text only (no markdown, no emoji, no headings, no bullet lists). Every figure you mention must be copied verbatim from the facts JSON - never invent, recompute, or extrapolate a number. NULL MEANS NOT MEASURED AND NOT SET: if a value is null, that thing was never recorded or never configured - say NOTHING about it at all. Never render null as zero, and never describe it as missed, over, failed, skipped, or lacking. In particular, if sleep_h is null the app has no sleep data, so do not mention sleep in any form. Only mention a metric when its value is a real number. workout_done=false means no session happened; if workout_ok is true on the same day it was a planned rest or forgiven day, so do not call it a miss. Currency is INR; write amounts as Rs. Cover: how yesterday closed, today's plan (workout and protein/calorie targets), safe-to-spend if present, any subscription due soon, and the strongest streak worth protecting. End with one concrete next move for the morning. Do NOT mention anything from reminders_due: those lines are appended verbatim after your text so they are guaranteed to be said, and repeating them makes the brief say the same thing twice.";

function jbVoiceUserPrompt(facts) {
  return "FACTS JSON:\n" + JSON.stringify(facts) + "\n\nWrite the morning brief now, plain text only.";
}
// ==== JARVIS-BRIEF MIRROR END ====

// -------- per-user data access (service role; RLS bypassed on purpose - this is
// the scheduled server acting FOR the user; every write is audit-logged) --------

type Profile = {
  id: string; display_name: string; timezone: string; briefing_enabled: boolean;
  push_enabled?: boolean; email_brief?: boolean; quiet_hours?: { start?: string; end?: string } | null;
};

// Test fixtures left behind in production. Matching on the profile alone keeps
// this cheap (no auth lookup per user per slot).
const FIXTURE_NAME_RE = /^(e2e|test|dummy|fixture|smoke)[_-]/i;
function isFixtureProfile(p: Profile & { display_name?: string }): boolean {
  return FIXTURE_NAME_RE.test(String(p?.display_name || "")) || FIXTURE_ID.has(p?.id);
}
// Explicit allow-list of known-abandoned fixture accounts (display_name here is
// "Ubhay", so the pattern above does not catch it).
const FIXTURE_ID = new Set<string>(["b788d68f-aee7-476b-9e50-f2cf9b3804c0"]);

async function fetchDayRows(admin: any, userId: string, startISO: string, endISO: string) {
  const [ledger, foods, workouts, wellness, metrics, sleep] = await Promise.all([
    admin.from("ledger_entries")
      .select("amount, direction, is_discretionary")
      .eq("user_id", userId).is("merged_into", null)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("food_logs")
      .select("protein_g, calories_estimate")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("workout_logs")
      // `status` decides whether this counts as training. Selecting it is what
      // stops a 'skipped' row ("no gym today") from reading as a workout.
      .select("duration_min, status")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("wellness_logs")
      .select("mood_score")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("body_metrics")
      .select("metric_type, value")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("sleep_sessions")
      .select("started_at, ended_at")
      .eq("user_id", userId).not("ended_at", "is", null)
      .gte("ended_at", startISO).lt("ended_at", endISO),
  ]);

  // A failed read is NOT an empty day. Returning [] on error is how a transient
  // Supabase blip became "you logged nothing yesterday", got frozen into
  // habit_days, and reset every streak. Fail loudly instead - the caller skips
  // the day rather than recording a fiction.
  const reads = { ledger, foods, workouts, wellness, metrics, sleep };
  for (const [name, res] of Object.entries(reads)) {
    if (res?.error) throw new Error(`fetchDayRows: ${name} read failed - ${res.error.message}`);
  }

  return {
    ledger: ledger.data || [],
    foods: foods.data || [],
    workouts: workouts.data || [],
    wellness: wellness.data || [],
    bodyMetrics: metrics.data || [],
    sleepSessions: sleep.data || [],
  };
}

async function fetchBudgets(admin: any, userId: string) {
  const { data } = await admin.from("budgets").select("kind, amount").eq("user_id", userId).not("kind", "is", null);
  return data || [];
}

async function fetchGymPayload(admin: any, userId: string) {
  const { data } = await admin.from("user_plans")
    .select("payload")
    .eq("user_id", userId).eq("kind", "gym").eq("scope", "permanent").eq("active", true)
    .order("created_at", { ascending: false }).limit(1);
  return data?.[0]?.payload ?? null;
}

async function fetchMonthSpend(admin: any, userId: string, dateKey: string, tz: string) {
  const monthStart = jbDayWindow(dateKey.slice(0, 8) + "01", tz).startISO;
  const end = jbDayWindow(dateKey, tz).endISO;
  const { data } = await admin.from("ledger_entries")
    .select("amount")
    .eq("user_id", userId).eq("direction", "expense").is("merged_into", null)
    .gte("occurred_at", monthStart).lt("occurred_at", end);
  return (data || []).reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0);
}

async function fetchSubsDue(admin: any, userId: string, now: Date) {
  const until = new Date(now.getTime() + 7 * 86400000);
  const { data } = await admin.from("subscriptions")
    .select("merchant, median_amount, next_expected_at")
    .eq("user_id", userId).eq("is_active", true)
    .gte("next_expected_at", now.toISOString()).lte("next_expected_at", until.toISOString())
    .order("next_expected_at", { ascending: true }).limit(4);
  return (data || []).map((s: any) => ({
    merchant: s.merchant,
    amount: Math.round(Number(s.median_amount) || 0),
    in_days: Math.max(0, Math.ceil((new Date(s.next_expected_at).getTime() - now.getTime()) / 86400000)),
  }));
}

async function fetchWeeklyWorkouts(admin: any, userId: string, dateKey: string, tz: string) {
  const start = jbDayWindow(jbAddDays(dateKey, -6), tz).startISO;
  const end = jbDayWindow(dateKey, tz).endISO;
  // Count DISTINCT training days, not rows. Tapping the "Went" button AND typing
  // "in gym doing back" on the same day writes two workout rows for one session;
  // counting rows would report 2 of your 4 weekly workouts for a single gym trip.
  const { data, error } = await admin.from("workout_logs")
    .select("occurred_at")
    .eq("user_id", userId).neq("status", "skipped")
    .gte("occurred_at", start).lt("occurred_at", end);
  if (error) throw new Error(`fetchWeeklyWorkouts read failed - ${error.message}`);
  const days = new Set((data || []).map((r: any) => jbDateKeyInTz(new Date(r.occurred_at), tz)));
  return days.size;
}

async function fetchHabitDay(admin: any, userId: string, dateKey: string) {
  const { data } = await admin.from("habit_days")
    .select("day, flags, streaks, summary")
    .eq("user_id", userId).eq("day", dateKey).maybeSingle();
  return data || null;
}

async function auditLog(admin: any, userId: string, action: string, after: unknown) {
  await admin.from("audit_log").insert({
    user_id: userId, action, target_table: "briefings", after, source: "jarvis",
  }).then(() => null, () => null);
}

async function withinDailyCap(admin: any, userId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await admin.from("ai_runs")
    .select("estimated_cost_usd")
    .eq("user_id", userId).gte("created_at", startOfDay.toISOString());
  if (error) return false; // fail CLOSED, same as the agent fn
  const sum = (data || []).reduce((acc: number, r: any) => acc + Number(r.estimated_cost_usd || 0), 0);
  return sum < DAILY_COST_CAP_USD;
}

function costOf(inUsdPerM: number, outUsdPerM: number, pt = 0, ot = 0) {
  return ((pt || 0) / 1_000_000) * inUsdPerM + ((ot || 0) / 1_000_000) * outUsdPerM;
}

// -------- claims: the INSERT is the lock --------
//
// `reminders.last_fired_on` was created, never read and never written, so a
// reminder inside its lead window re-fired every day - GST at lead_days=7 was
// EIGHT identical morning pushes. A `date` column also cannot express two fires
// in one day, and an update-after-send races the GitHub heartbeat.
//
// So the claim is an INSERT, exactly like the email_deliveries partial unique
// index above: two schedulers race the same row, one wins, the loser gets a
// unique violation and treats it as a successful no-op rather than an error.

// True when THIS caller won the right to fire (reminder, occurrence, channel).
// A read error is NOT a win: firing on an unverifiable claim is how the
// duplicate-notification bug comes back.
async function claimReminderFire(
  admin: any, userId: string, reminderId: string, key: string, channel: string, detail: unknown,
): Promise<boolean> {
  if (!reminderId || !key) return false;
  const { error } = await admin.from("reminder_fires").insert({
    user_id: userId, reminder_id: reminderId, occurrence_key: key, channel, detail: detail ?? {},
  });
  if (!error) return true;
  if (/duplicate key|unique/i.test(error.message || "")) return false; // already fired - a no-op, not a failure
  console.error(`reminder_fires claim failed for ${reminderId} ${key}: ${error.message}`);
  return false;
}

// Generalised slot claim with a stale lease, so pg_cron and the GitHub heartbeat
// COLLIDE rather than double-fire, and a crashed run cannot wedge a slot forever.
async function claimJob(admin: any, userId: string, job: string, slotKey: string, leaseSeconds = 600): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_job", {
    p_user: userId, p_job: job, p_slot: slotKey, p_lease_seconds: leaseSeconds,
  });
  if (error) {
    // An unverifiable claim is a lost claim. The alternative - assuming we hold
    // it - is the duplicate send this table exists to prevent.
    console.error(`claim_job failed for ${job}/${slotKey}: ${error.message}`);
    return false;
  }
  return data === true;
}

async function finishJob(admin: any, userId: string, job: string, slotKey: string, status: string, detail: unknown) {
  await admin.rpc("finish_job", {
    p_user: userId, p_job: job, p_slot: slotKey, p_status: status, p_detail: detail ?? {},
  }).then(() => null, () => null);
}

// -------- autonomy governance (mirrors lib/agent-tasks.mjs) --------

// FAILS CLOSED. `profile` is null when the read errored or the row is missing,
// and both mean no; `!== true` rather than `=== false` because an undefined flag
// (a column not selected, a PostgREST cache that has not reloaded) is not
// permission either. Everywhere else in this codebase a failed read must be
// surfaced rather than swallowed - this is the one read that must ALSO be
// treated as "no", because the alternative is an unsupervised model writing rows.
function autonomyAllowed(profile: any): { allowed: boolean; reason: string } {
  if (!profile || typeof profile !== "object") return { allowed: false, reason: "autonomy_flag_unreadable" };
  if (profile.autonomy_enabled !== true) return { allowed: false, reason: "autonomy_disabled" };
  return { allowed: true, reason: "" };
}

function autonomyBudget(profile: any): number {
  const n = Number(profile && profile.autonomy_daily_cost_usd);
  if (!Number.isFinite(n) || n < 0) return AUTONOMY_DAILY_COST_USD;
  return Math.min(n, 2);
}

// Keys sorted at every level, so {a,b} and {b,a} fingerprint the same.
function atStableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(atStableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${atStableStringify(value[k])}`).join(",")}}`;
}

// FNV-1a over the tool calls. Deterministic and dependency-free rather than
// cryptographic - the worst case for a collision is one false "this is a loop".
// Confidence, timestamps and ids are deliberately NOT in it: two runs that
// emitted the same answer at different confidences are the same loop.
function actionHash(calls: any[]): string {
  const shaped = (calls || []).map((c: any) => ({ name: String((c && c.name) || ""), args: (c && c.arguments) || {} }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const text = atStableStringify(shaped);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Split proposed calls into what may commit and what may not. Blocked calls are
// RETURNED, not dropped - an autonomous run that wanted to change a budget is
// exactly the thing a human should get to see afterwards.
function filterAutonomousActions(calls: any[], depth: number) {
  const allowed: any[] = [];
  const blocked: any[] = [];
  for (const call of calls || []) {
    const name = String((call && call.name) || "");
    if (!name) { blocked.push({ name: "", reason: "unnamed_tool" }); continue; }
    if (name === "schedule_agent_task" || name === "create_agent_task") {
      blocked.push({ name, reason: depth >= AUTONOMY_MAX_DEPTH ? "depth_cap" : "not_autonomous" });
      continue;
    }
    if (!AUTONOMOUS_TOOLS.includes(name)) { blocked.push({ name, reason: "not_autonomous" }); continue; }
    allowed.push(call);
  }
  return { allowed, blocked };
}

// -------- the voice: DeepSeek-chat prose → Gemini → null (caller falls back) --------

function tidyVoice(raw: string): string {
  const s = String(raw || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 900 ? s.slice(0, 897) + "…" : s;
}

async function voiceBrief(admin: any, userId: string, facts: unknown) {
  if (!(await withinDailyCap(admin, userId))) return null;

  const deepseekKey = await resolveAnySecret(["DEEPSEEK_API_KEY", "NVIDIA_API_KEY"]);
  if (deepseekKey) {
    try {
      const url = (await resolveSecretOptional("DEEPSEEK_BASE_URL")) || DEEPSEEK_URL;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deepseekKey}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          temperature: 0.4,
          max_tokens: 400,
          messages: [
            { role: "system", content: JB_VOICE_SYSTEM },
            { role: "user", content: jbVoiceUserPrompt(facts) },
          ],
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const body = tidyVoice(json.choices?.[0]?.message?.content ?? "");
        const usage = json.usage || {};
        if (body.length > 40) {
          await logVoiceRun(admin, userId, "deepseek", DEEPSEEK_MODEL, usage.prompt_tokens, usage.completion_tokens,
            costOf(DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD, usage.prompt_tokens, usage.completion_tokens));
          return { body, provider: "deepseek", model: DEEPSEEK_MODEL };
        }
      }
    } catch { /* fall through to Gemini */ }
  }

  try {
    const apiKey = await resolveSecret("GEMINI_API_KEY");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const res = await fetch(`${url}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: JB_VOICE_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: jbVoiceUserPrompt(facts) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
    });
    if (res.ok) {
      const json = await res.json();
      const body = tidyVoice(json.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
      const usage = json.usageMetadata || {};
      if (body.length > 40) {
        await logVoiceRun(admin, userId, "gemini", GEMINI_MODEL, usage.promptTokenCount, usage.candidatesTokenCount,
          costOf(GEMINI_IN_USD, GEMINI_OUT_USD, usage.promptTokenCount, usage.candidatesTokenCount));
        return { body, provider: "gemini", model: GEMINI_MODEL };
      }
    }
  } catch { /* deterministic fallback in the caller */ }
  return null;
}

async function logVoiceRun(admin: any, userId: string, provider: string, model: string, pt = 0, ot = 0, cost = 0) {
  await admin.from("ai_runs").insert({
    user_id: userId, provider, model, purpose: "jarvis_voice",
    prompt_tokens: pt || 0, output_tokens: ot || 0,
    estimated_cost_usd: cost, status: "succeeded",
  }).then(() => null, () => null);
}

// -------- delivery: Resend email + Web Push --------

// ==== EMAIL-TEMPLATE MIRROR START (byte-identical in lib/email-template.mjs) ====
var ET_APP_URL = "https://ubhayaab.github.io/trackerz/";
var ET_INK = "#17211c";
var ET_MUTED = "#7c8a82";
var ET_ACCENT = "#138a5b";
var ET_LINE = "#e3e9e5";
var ET_BG = "#f6f8f7";

function etEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function etRupees(n) {
  return "Rs " + (Math.round(Number(n) || 0)).toLocaleString("en-IN");
}

// A stat is worth showing only when it is a real number. null/undefined/NaN mean
// "not measured" and must vanish entirely rather than becoming a zero.
function etHasValue(v) {
  return v !== null && v !== undefined && !(typeof v === "number" && !isFinite(v));
}

// Build the stat rows for a brief from its facts JSON. Order is fixed so the
// email reads the same every day.
function etStatsFromFacts(facts) {
  var out = [];
  if (!facts) return out;
  var y = facts.yesterday;
  if (y) {
    if (etHasValue(y.calories) && y.calories > 0) out.push({ label: "Calories yesterday", value: String(Math.round(y.calories)) + " kcal" });
    if (etHasValue(y.protein) && y.protein > 0) out.push({ label: "Protein yesterday", value: String(Math.round(y.protein)) + " g" });
    if (etHasValue(y.spend)) out.push({ label: "Spent yesterday", value: etRupees(y.spend) });
    // sleep_h is null whenever no sleep was recorded - omit, never render 0.
    if (etHasValue(y.sleep_h) && y.sleep_h > 0) out.push({ label: "Slept", value: String(y.sleep_h) + " h" });
    if (etHasValue(y.weight_kg)) out.push({ label: "Weight", value: String(y.weight_kg) + " kg" });
    out.push({ label: "Workout yesterday", value: y.workout_done ? "done" : (y.workout_ok ? "rest day" : "not logged") });
  }
  if (facts.workout && facts.workout.name) out.push({ label: "Today's workout", value: facts.workout.name });
  if (facts.diet_label) out.push({ label: "Today's diet", value: facts.diet_label });
  var t = facts.targets || {};
  if (etHasValue(t.protein_g)) out.push({ label: "Protein target", value: String(Math.round(t.protein_g)) + " g" });
  if (etHasValue(t.calories)) out.push({ label: "Calorie target", value: String(Math.round(t.calories)) + " kcal" });
  if (facts.money && facts.money.hasBudget) {
    out.push({ label: "Safe to spend today", value: etRupees(facts.money.perDay) });
  }
  var st = facts.streaks || {};
  var streaks = [];
  if (st.workout > 1) streaks.push("gym " + st.workout + "d");
  if (st.protein > 1) streaks.push("protein " + st.protein + "d");
  if (st.budget > 1) streaks.push("budget " + st.budget + "d");
  if (st.logging > 1) streaks.push("logging " + st.logging + "d");
  if (streaks.length) out.push({ label: "Streaks", value: streaks.join(" · ") });
  return out;
}

function etStatRows(stats) {
  var rows = "";
  for (var i = 0; i < (stats || []).length; i++) {
    var s = stats[i];
    var border = i === 0 ? "none" : "1px solid " + ET_LINE;
    rows += '<tr>'
      + '<td style="padding:9px 0;border-top:' + border + ';font-size:14px;color:' + ET_MUTED + '">' + etEscape(s.label) + '</td>'
      + '<td style="padding:9px 0;border-top:' + border + ';font-size:14px;color:' + ET_INK + ';font-weight:600;text-align:right;white-space:nowrap">' + etEscape(s.value) + '</td>'
      + '</tr>';
  }
  return rows;
}

function etBulletList(items) {
  if (!items || !items.length) return "";
  var lis = "";
  for (var i = 0; i < items.length; i++) {
    lis += '<li style="margin:0 0 6px;font-size:15px;line-height:1.5;color:' + ET_INK + '">' + etEscape(items[i]) + "</li>";
  }
  return '<ul style="margin:14px 0 0;padding-left:20px">' + lis + "</ul>";
}

// The one email shell. `kind` only changes the eyebrow and the accent word.
function etRenderEmail(o) {
  var opts = o || {};
  var title = opts.title || "Deno";
  var eyebrow = opts.eyebrow || "Deno";
  var body = opts.body || "";
  var stats = opts.stats || [];
  var bullets = opts.bullets || [];
  var ctaLabel = opts.ctaLabel || "Open Deno";
  var footerNote = opts.footerNote || "";

  var statsBlock = stats.length
    ? '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;border-collapse:collapse">' + etStatRows(stats) + "</table>"
    : "";

  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light">'
    + "<title>" + etEscape(title) + "</title></head>"
    + '<body style="margin:0;padding:0;background:' + ET_BG + '">'
    // Preheader: the grey preview line in the inbox list. Without it, clients
    // show the eyebrow text, which is identical every day and tells you nothing.
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + etEscape(String(body).slice(0, 140)) + "</div>"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:' + ET_BG + ';padding:24px 12px">'
    + "<tr><td align=\"center\">"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ' + ET_LINE + ';border-radius:14px;overflow:hidden">'
    + '<tr><td style="padding:22px 24px 0">'
    + '<p style="margin:0 0 10px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:' + ET_ACCENT + ';font-weight:700">' + etEscape(eyebrow) + "</p>"
    + '<p style="margin:0;font-size:16px;line-height:1.6;color:' + ET_INK + '">' + etEscape(body) + "</p>"
    + etBulletList(bullets)
    + statsBlock
    + "</td></tr>"
    + '<tr><td style="padding:20px 24px 24px">'
    + '<a href="' + ET_APP_URL + '" style="display:inline-block;background:' + ET_ACCENT + ';color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:999px">' + etEscape(ctaLabel) + "</a>"
    + "</td></tr>"
    + '<tr><td style="padding:14px 24px 20px;border-top:1px solid ' + ET_LINE + ';background:#fbfcfb">'
    + (footerNote ? '<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:' + ET_MUTED + '">' + etEscape(footerNote) + "</p>" : "")
    + '<p style="margin:0;font-size:12px;line-height:1.5;color:' + ET_MUTED + '">'
    + 'Every number here comes from what you logged. Turn these off any time in '
    + '<a href="' + ET_APP_URL + 'pages/settings.html" style="color:' + ET_ACCENT + '">Settings &rarr; Jarvis</a>.'
    + "</p></td></tr>"
    + "</table></td></tr></table></body></html>";
}

// text/plain alternative. Spam filters penalise HTML-only mail, and it is what
// a watch or a screen reader actually reads out.
function etRenderText(o) {
  var opts = o || {};
  var lines = [String(opts.body || "").trim()];
  var bullets = opts.bullets || [];
  for (var i = 0; i < bullets.length; i++) lines.push("- " + bullets[i]);
  var stats = opts.stats || [];
  if (stats.length) {
    lines.push("");
    for (var j = 0; j < stats.length; j++) lines.push(stats[j].label + ": " + stats[j].value);
  }
  lines.push("");
  lines.push(ET_APP_URL);
  lines.push("Manage these emails: " + ET_APP_URL + "pages/settings.html");
  return lines.join("\n");
}

// Subject lines carry the headline number so the inbox list is useful without
// opening anything. Never invent one - fall back to a plain subject.
function etSubjectFor(kind, facts, dateLabel) {
  var y = facts && facts.yesterday;
  if (kind === "morning") {
    if (y && y.logged_anything && etHasValue(y.calories) && y.calories > 0) {
      return "Morning brief - " + Math.round(y.calories) + " kcal yesterday";
    }
    return "Morning brief" + (dateLabel ? " - " + dateLabel : "");
  }
  if (kind === "evening") return "Evening check-in - still time";
  if (kind === "closeout") return "Day closed" + (dateLabel ? " - " + dateLabel : "");
  if (kind === "weekly") return "Your week in review";
  return "Deno";
}

var ET_EYEBROWS = {
  morning: "Deno · Morning brief",
  evening: "Deno · Evening check-in",
  closeout: "Deno · Day closed",
  weekly: "Deno · Weekly review",
  alert: "Deno · Alert",
  test: "Deno · Test",
};

// One call site for the whole service: kind + body + facts -> {subject, html, text}.
function etBuildMessage(o) {
  var opts = o || {};
  var kind = opts.kind || "morning";
  var facts = opts.facts || null;
  var stats = opts.stats || (facts ? etStatsFromFacts(facts) : []);
  var payload = {
    title: opts.subject || etSubjectFor(kind, facts, opts.dateLabel),
    eyebrow: ET_EYEBROWS[kind] || ET_EYEBROWS.morning,
    body: opts.body || "",
    stats: stats,
    bullets: opts.bullets || [],
    ctaLabel: opts.ctaLabel || (kind === "evening" ? "Log the rest of today" : "Open Deno"),
    footerNote: opts.footerNote || "",
  };
  return {
    subject: payload.title,
    html: etRenderEmail(payload),
    text: etRenderText(payload),
  };
}
// ==== EMAIL-TEMPLATE MIRROR END ====

async function userEmail(admin: any, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch { return null; }
}

// Per-kind opt-outs. One master switch used to gate every message, so silencing
// the 20:30 nudge also silenced the morning brief.
const EMAIL_PREF_COLUMN: Record<string, string> = {
  morning: "email_morning",
  evening: "email_evening",
  closeout: "email_closeout",
  weekly: "email_weekly",
  alert: "email_alerts",
};

function emailEnabledFor(profile: any, kind: string): boolean {
  if (profile?.email_brief === false) return false; // master switch still wins
  const col = EMAIL_PREF_COLUMN[kind];
  if (!col) return true;
  return profile?.[col] !== false;
}

// Retryable: a network blip or a Resend 429/5xx. A 4xx is a real rejection
// (bad address, unverified sender) and retrying it just burns quota.
function isRetryableEmailStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Send one Jarvis email and RECORD the attempt.
 *
 * Every send writes an email_deliveries row, so a bounce or a rejected sender
 * is inspectable in the app afterwards instead of vanishing into a function
 * log. A partial unique index on (user, kind, for_date) where status='sent'
 * makes a re-fired cron slot collide rather than send a duplicate.
 */
async function sendEmail(
  admin: any,
  userId: string,
  kind: string,
  opts: { body: string; facts?: any; bullets?: string[]; subject?: string; forDate?: string | null; dateLabel?: string; profile?: any },
) {
  if (opts.profile && !emailEnabledFor(opts.profile, kind)) {
    return { sent: false, reason: "disabled_by_preference" };
  }
  const key = await resolveSecretOptional("RESEND_API_KEY");
  if (!key) return { sent: false, reason: "no_resend_key" };
  const to = await userEmail(admin, userId);
  if (!to) return { sent: false, reason: "no_email" };

  const from = (await resolveSecretOptional("JARVIS_EMAIL_FROM")) || "Jarvis <onboarding@resend.dev>";
  const message = etBuildMessage({
    kind,
    body: opts.body,
    facts: opts.facts || null,
    bullets: opts.bullets || [],
    subject: opts.subject,
    dateLabel: opts.dateLabel,
  });
  const forDate = opts.forDate ?? null;

  // Claim the slot first. A unique-violation here means this exact message was
  // already delivered - that is a successful no-op, not an error.
  const { data: claim, error: claimErr } = await admin.from("email_deliveries").insert({
    user_id: userId, kind, for_date: forDate, to_email: to, subject: message.subject, status: "queued",
  }).select("id").single();
  if (claimErr && /duplicate key|unique/i.test(claimErr.message || "")) {
    return { sent: false, reason: "already_sent" };
  }
  const deliveryId = claim?.id ?? null;

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ from, to, subject: message.subject, html: message.html, text: message.text }),
      });
      const raw = await res.text();
      if (res.ok) {
        let providerId: string | null = null;
        try { providerId = JSON.parse(raw)?.id ?? null; } catch { /* id is a nicety */ }
        if (deliveryId) {
          await admin.from("email_deliveries").update({
            status: "sent", provider_message_id: providerId, attempts: attempt, sent_at: new Date().toISOString(),
          }).eq("id", deliveryId);
        }
        return { sent: true, id: providerId, attempts: attempt };
      }
      lastError = `resend_${res.status}: ${raw.slice(0, 200)}`;
      if (!isRetryableEmailStatus(res.status)) break;
    } catch (err) {
      lastError = String(err).slice(0, 200);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 700));
  }

  if (deliveryId) {
    await admin.from("email_deliveries").update({ status: "failed", error: lastError, attempts: 3 }).eq("id", deliveryId);
  }
  return { sent: false, reason: lastError || "unknown" };
}

let _appServer: any = null;
async function pushServer() {
  if (_appServer) return _appServer;
  const jwkJson = await resolveSecretOptional("JARVIS_VAPID_JWK");
  if (!jwkJson) return null;
  try {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(jwkJson), { extractable: false });
    const contact = (await resolveSecretOptional("JARVIS_VAPID_CONTACT")) || "mailto:ubhayvatsaanand@gmail.com";
    _appServer = await webpush.ApplicationServer.new({ contactInformation: contact, vapidKeys });
    return _appServer;
  } catch {
    return null;
  }
}

async function sendPush(admin: any, profile: Profile, title: string, body: string, now: Date) {
  if (profile.push_enabled === false) return { sent: 0, reason: "push_disabled" };
  if (jbInQuietHours(now, profile.timezone || "Asia/Kolkata", profile.quiet_hours)) {
    return { sent: 0, reason: "quiet_hours" };
  }
  const server = await pushServer();
  if (!server) return { sent: 0, reason: "no_vapid" };
  const { data: subs } = await admin.from("push_subscriptions")
    .select("id, endpoint, keys").eq("user_id", profile.id);
  if (!subs?.length) return { sent: 0, reason: "no_subscriptions" };

  let sent = 0;
  for (const sub of subs) {
    try {
      const subscriber = server.subscribe({ endpoint: sub.endpoint, keys: sub.keys });
      await subscriber.pushTextMessage(
        JSON.stringify({ title, body, url: "https://ubhayaab.github.io/trackerz/" }),
        { ttl: 3600 },
      );
      sent++;
      await admin.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", sub.id);
    } catch (err: any) {
      const status = err?.response?.status ?? 0;
      if (status === 404 || status === 410) {
        // Endpoint expired/unsubscribed - prune it.
        await admin.from("push_subscriptions").delete().eq("id", sub.id);
      }
    }
  }
  return { sent };
}

// -------- briefings persistence --------

async function upsertBriefing(admin: any, userId: string, kind: string, forDate: string, body: string, payload: unknown) {
  const { data, error } = await admin.from("briefings")
    .upsert(
      { user_id: userId, kind, for_date: forDate, body, payload, seen: false, created_at: new Date().toISOString() },
      { onConflict: "user_id,kind,for_date" },
    )
    .select("id").single();
  if (error) throw new Error(`briefings upsert failed: ${error.message}`);
  return data?.id ?? null;
}

// -------- actions --------

// Close one civil day: habit_days (+streak roll), closeout briefing, and on
// Sundays the weekly_reviews row + weekly briefing.
async function runCloseout(admin: any, profile: Profile, dateKey: string, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const existing = await fetchHabitDay(admin, profile.id, dateKey);
  if (existing && !force) return { userId: profile.id, action: "closeout", forDate: dateKey, skipped: "exists" };

  const win = jbDayWindow(dateKey, tz);
  const [rows, budgets, gymPayload] = await Promise.all([
    fetchDayRows(admin, profile.id, win.startISO, win.endISO),
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
  ]);
  const plannedKind = jbPlannedWorkout(jbWeekdayFromKey(dateKey), gymPayload).kind;
  const day = jbCloseDay({ ...rows, budgets, plannedKind });
  const prev = await fetchHabitDay(admin, profile.id, jbAddDays(dateKey, -1));
  const streaks = jbNextStreaks(prev?.streaks, day.flags);

  const { error: hdErr } = await admin.from("habit_days").upsert(
    { user_id: profile.id, day: dateKey, flags: day.flags, streaks, summary: day },
    { onConflict: "user_id,day" },
  );
  if (hdErr) throw new Error(`habit_days upsert failed: ${hdErr.message}`);

  const body = jbCloseoutBody(day, streaks);
  const briefingId = await upsertBriefing(admin, profile.id, "closeout", dateKey, body, { summary: day, streaks });

  const delivery: Record<string, unknown> = {};
  let weekly = null;
  if (jbWeekdayFromKey(dateKey) === 7) {
    const weekStart = jbAddDays(dateKey, -6);
    const { data: weekRows } = await admin.from("habit_days")
      .select("day, flags, streaks, summary")
      .eq("user_id", profile.id).gte("day", weekStart).lte("day", dateKey)
      .order("day", { ascending: true });
    weekly = jbWeeklySummary(weekRows || []);
    const { error: wrErr } = await admin.from("weekly_reviews").upsert(
      { user_id: profile.id, week_start: weekStart, summary: weekly },
      { onConflict: "user_id,week_start" },
    );
    if (wrErr) throw new Error(`weekly_reviews upsert failed: ${wrErr.message}`);
    const wBody = `Week closed: ${weekly.totals.workouts} workouts, protein hit ${weekly.hits.protein_days}/${weekly.days} days, `
      + `under budget ${weekly.hits.budget_days}/${weekly.days}, ${jbRupees(weekly.totals.spend)} spent.`;
    await upsertBriefing(admin, profile.id, "weekly", dateKey, wBody, { weekly, week_start: weekStart });

    // The weekly review is the one message worth reading in full, and it was
    // never emailed - it only ever existed as a row nobody opened.
    delivery.weeklyEmail = await sendEmail(admin, profile.id, "weekly", {
      body: wBody,
      forDate: dateKey,
      profile,
      stats: [
        { label: "Workouts", value: `${weekly.totals.workouts} / ${weekly.days} days` },
        { label: "Protein hit", value: `${weekly.hits.protein_days} / ${weekly.days} days` },
        { label: "Under budget", value: `${weekly.hits.budget_days} / ${weekly.days} days` },
        { label: "Days logged", value: `${weekly.hits.logged_days} / ${weekly.days}` },
        { label: "Spent", value: jbRupees(weekly.totals.spend) },
        { label: "Avg protein", value: `${weekly.averages.protein} g` },
        { label: "Avg calories", value: `${weekly.averages.calories} kcal` },
      ].concat(
        // sleep_h is null when the week has no sleep data at all - omit the row
        // rather than reporting an average of zero.
        weekly.averages.sleep_h != null ? [{ label: "Avg sleep", value: `${weekly.averages.sleep_h} h` }] : [],
      ),
    });
  }

  // Off by default: this fires at 00:05 and is the least useful thing to be
  // emailed at midnight. Opt in per-kind in Settings.
  delivery.email = await sendEmail(admin, profile.id, "closeout", {
    body, forDate: dateKey, dateLabel: dateKey, profile,
    stats: [
      { label: "Spent", value: jbRupees(day.spend) },
      { label: "Calories", value: `${day.calories} kcal` },
      { label: "Protein", value: `${day.protein} g` },
      { label: "Workout", value: day.workoutDone ? "done" : (day.flags.workout_forgiven ? "rest day" : "not logged") },
    ],
  });

  await auditLog(admin, profile.id, "jarvis.closeout", { forDate: dateKey, briefingId, flags: day.flags, streaks, weekly: Boolean(weekly), delivery });
  return { userId: profile.id, action: "closeout", forDate: dateKey, briefingId, flags: day.flags, streaks, weekly: Boolean(weekly), delivery };
}

// Morning brief: self-heal yesterday's closeout, build facts, narrate, deliver.
// Active reminders for a user. Rows are calendar RULES, not events - the next
// occurrence is computed in-process by lib/reminders.mjs (mirrored above), so
// this is a plain select with no date filtering in SQL.
const REMINDER_COLUMNS = "id, title, note, kind, freq, day_of_month, month_of_year, weekday, on_date, lead_days, active"
  // 20260806000030 - the recurrence modifiers. Selecting them is not optional:
  // a rule stored with an interval and read WITHOUT it silently degrades to
  // "every week", which is a wrong date announced with total confidence.
  + ", rule_interval, dtstart, nth_weekday, weekdays, until, max_count, exdates, rdates, at_time, timezone";

async function fetchReminders(admin: any, userId: string) {
  const { data, error } = await admin.from("reminders")
    .select(REMINDER_COLUMNS)
    .eq("user_id", userId).eq("active", true);
  // A failed read must NOT look like "you have no reminders". Swallowing this is
  // how a missed tax deadline would present as a perfectly normal quiet morning -
  // the exact computed-then-never-surfaced failure this codebase keeps hitting.
  // (It bit immediately: the first live test returned nothing because PostgREST
  // had not reloaded its schema cache after the table was created, and the empty
  // array was indistinguishable from having none.)
  if (error) throw new Error(`reminders_unavailable: ${error.message}`);
  return data || [];
}

async function runMorning(admin: any, profile: Profile, now: Date, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const todayKey = jbDateKeyInTz(now, tz);
  const ydayKey = jbAddDays(todayKey, -1);

  const { data: existingRow } = await admin.from("briefings")
    .select("id").eq("user_id", profile.id).eq("kind", "morning").eq("for_date", todayKey).maybeSingle();
  if (existingRow && !force) return { userId: profile.id, action: "morning", forDate: todayKey, skipped: "exists" };

  let yday = await fetchHabitDay(admin, profile.id, ydayKey);
  if (!yday) {
    await runCloseout(admin, profile, ydayKey, false);
    yday = await fetchHabitDay(admin, profile.id, ydayKey);
  }

  const [budgets, gymPayload, monthSpend, subsDue, weeklyWorkouts, allReminders] = await Promise.all([
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
    fetchMonthSpend(admin, profile.id, todayKey, tz),
    fetchSubsDue(admin, profile.id, now),
    fetchWeeklyWorkouts(admin, profile.id, todayKey, tz),
    fetchReminders(admin, profile.id),
  ]);
  // What is due today or inside its own lead window. This is the whole point of
  // the feature: a quarterly filing has to speak up a week early, on its own,
  // without the user having remembered to look.
  const remindersDue = dueReminders(allReminders, todayKey);

  const facts = jbBriefFacts({
    dateKey: todayKey, budgets, gymPayload,
    yesterday: yday ? { ...(yday.summary || {}), flags: yday.flags } : null,
    streaks: yday?.streaks || {},
    monthSpend, subsDue, weeklyWorkouts, remindersDue,
  });

  const voice = await voiceBrief(admin, profile.id, facts);
  // The voice model may only PHRASE the facts JSON, and a missed deadline is the
  // one thing that must never depend on it having chosen to mention something.
  // Reminder lines are appended deterministically, after the narration.
  const reminderText = reminderLines(remindersDue).join(" ");
  const narrated = voice?.body || jbMorningFallback(facts);
  const body = reminderText ? `${narrated} ${reminderText}` : narrated;
  const briefingId = await upsertBriefing(admin, profile.id, "morning", todayKey, body, {
    facts, voice: voice ? { provider: voice.provider, model: voice.model } : "fallback",
  });

  const delivery: Record<string, unknown> = {};
  if (profile.email_brief !== false) {
    delivery.email = await sendEmail(admin, profile.id, "morning", {
      body, facts, forDate: todayKey, dateLabel: facts.weekday, profile,
    });
  }

  // A due reminder leads the push. "Morning brief" on the lock screen is a thing
  // you swipe; "File quarterly GST" is a thing you open.
  //
  // But it may only lead ONCE per stage. GST at lead_days=7 is inside its window
  // for eight consecutive mornings, and before the claim below that meant eight
  // identical escalated pushes - which teaches you to swipe away everything this
  // app sends, costing the other three slots their credibility too. Two pushes
  // per occurrence is the design: one when the window OPENS, one on the DAY.
  // The brief BODY still lists every due reminder, because that is one message a
  // day either way and a filing you are not reminded of is the actual failure.
  const escalations: any[] = [];
  for (const r of remindersDue) {
    const stage = Number(r.days_away) === 0 ? "due" : "lead";
    const won = await claimReminderFire(admin, profile.id, r.id, r.occurrence_key, `push_${stage}`, {
      slot: "morning", for_date: todayKey, days_away: r.days_away,
    });
    if (won) escalations.push(r);
  }
  const pushTitle = escalations.length ? escalations[0].title : "Morning brief";
  const escalationText = reminderLines(escalations).join(" ");
  const pushBody = escalations.length ? `${escalationText} ${narrated}`.slice(0, 160) : body.slice(0, 160);
  delivery.push = await sendPush(admin, profile, pushTitle, pushBody, now);
  delivery.reminderEscalations = escalations.map((r) => ({ id: r.id, key: r.occurrence_key }));

  await auditLog(admin, profile.id, "jarvis.morning", { forDate: todayKey, briefingId, voice: voice?.provider || "fallback", delivery });
  return { userId: profile.id, action: "morning", forDate: todayKey, briefingId, voice: voice?.provider || "fallback", delivery };
}

// Midday pace check. Push only - never email, because the point is a glance you
// can act on, not another thing in the inbox.
//
// Why this slot exists: the evening nudge at 20:30 lands after the day is
// decided. The owner runs ~87g of protein against a 151-162g target, and at
// 20:30 there is one meal left to close a 75g gap. 14:30 is early enough to act.
//
// It is deliberately SILENT when there is nothing concrete to say. jbMiddayBody
// returns a null body on a day that is on track, and this returns without
// writing a briefing or sending anything - a notification that fires every day
// regardless of content is one the user learns to dismiss without reading.
async function runMidday(admin: any, profile: Profile, now: Date, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const todayKey = jbDateKeyInTz(now, tz);

  const { data: existingRow } = await admin.from("briefings")
    .select("id").eq("user_id", profile.id).eq("kind", "midday").eq("for_date", todayKey).maybeSingle();
  if (existingRow && !force) return { userId: profile.id, action: "midday", forDate: todayKey, skipped: "exists" };

  const win = jbDayWindow(todayKey, tz);
  const [rows, budgets, gymPayload] = await Promise.all([
    fetchDayRows(admin, profile.id, win.startISO, now.toISOString()),
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
  ]);
  const planned = jbPlannedWorkout(jbWeekdayFromKey(todayKey), gymPayload);
  const sofar = jbCloseDay({ ...rows, budgets, plannedKind: planned.kind });

  // Hours of the local day still ahead, so "still to do" is only said while it
  // is still true. jbMinutesOfDay parses "HH:MM", so format the instant in the
  // user's zone first - reading the server's UTC clock would be 5.5h out.
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(now);
  const hoursLeftInDay = Math.max(0, (24 * 60 - (jbMinutesOfDay(hm) ?? 0)) / 60);

  const midday = jbMiddayBody({
    proteinTarget: sofar.caps.proteinTarget, proteinToday: sofar.protein,
    caloriesTarget: sofar.caps.caloriesTarget, caloriesToday: sofar.calories,
    // `rows.foods` - fetchDayRows has never returned a `foodLogs` key, so this
    // read was undefined every time and mealsLogged was permanently 0. That made
    // jbMiddayBody take its `meals === 0` branch on every single day: the 14:30
    // push said "nothing logged yet today" regardless of what had been eaten,
    // and the protein-pace line it exists for could never be reached.
    mealsLogged: (rows.foods || []).length,
    plannedKind: planned.kind, plannedName: planned.name, workoutLogged: sofar.workoutDone,
    spendCap: sofar.caps.spendCap, todaySpend: sofar.spend,
    hoursLeftInDay,
  });

  if (!midday.body) {
    return { userId: profile.id, action: "midday", forDate: todayKey, skipped: "on_track" };
  }

  const briefingId = await upsertBriefing(admin, profile.id, "midday", todayKey, midday.body, {
    headline: midday.headline, nudges: midday.nudges, snapshot: sofar,
  });
  const delivery: Record<string, unknown> = {};
  delivery.push = await sendPush(admin, profile, midday.headline || "Midday check", midday.body, now);

  await auditLog(admin, profile.id, "jarvis.midday", { forDate: todayKey, briefingId, nudges: midday.nudges.length, delivery });
  return { userId: profile.id, action: "midday", forDate: todayKey, briefingId, nudges: midday.nudges, delivery };
}

// Evening nudge: what is still fixable today. Push always (outside quiet hours);
// email only when there is something actionable.
async function runEvening(admin: any, profile: Profile, now: Date, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const todayKey = jbDateKeyInTz(now, tz);

  const { data: existingRow } = await admin.from("briefings")
    .select("id").eq("user_id", profile.id).eq("kind", "evening").eq("for_date", todayKey).maybeSingle();
  if (existingRow && !force) return { userId: profile.id, action: "evening", forDate: todayKey, skipped: "exists" };

  const win = jbDayWindow(todayKey, tz);
  const [rows, budgets, gymPayload] = await Promise.all([
    fetchDayRows(admin, profile.id, win.startISO, now.toISOString()),
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
  ]);
  const planned = jbPlannedWorkout(jbWeekdayFromKey(todayKey), gymPayload);
  const sofar = jbCloseDay({ ...rows, budgets, plannedKind: planned.kind });
  const evening = jbEveningBody({
    proteinTarget: sofar.caps.proteinTarget, proteinToday: sofar.protein,
    caloriesTarget: sofar.caps.caloriesTarget, caloriesToday: sofar.calories,
    plannedKind: planned.kind, plannedName: planned.name, workoutLogged: sofar.workoutDone,
    spendCap: sofar.caps.spendCap, todaySpend: sofar.spend,
  });

  const briefingId = await upsertBriefing(admin, profile.id, "evening", todayKey, evening.body, {
    headline: evening.headline, nudges: evening.nudges, snapshot: sofar,
  });

  const delivery: Record<string, unknown> = {};
  delivery.push = await sendPush(admin, profile, evening.headline, evening.nudges.join(" · ") || evening.body, now);
  // Only email when something is still fixable - an "all clear" at 20:30 is not
  // worth an inbox interruption, and unread mail is how people learn to ignore
  // the ones that matter.
  if (evening.nudges.length) {
    delivery.email = await sendEmail(admin, profile.id, "evening", {
      body: evening.body, bullets: evening.nudges, forDate: todayKey, profile,
      subject: `Evening check-in - ${evening.nudges.length} thing${evening.nudges.length === 1 ? "" : "s"} still open`,
    });
  }

  await auditLog(admin, profile.id, "jarvis.evening", { forDate: todayKey, briefingId, nudges: evening.nudges.length, delivery });
  return { userId: profile.id, action: "evening", forDate: todayKey, briefingId, nudges: evening.nudges, delivery };
}

// ===========================================================================
// THE MINUTE CLOCK - "when the scheduled task, it has to trigger on its own and
// wake up."
//
// pg_cron fires jarvis_ping('task') every minute (20260806000030). Two jobs:
//   1. reminders that carry an at_time, which the four fixed slots could never
//      express - everything was date-granularity, so the finest thing the app
//      could say was "sometime on the 14th", announced at 07:00.
//   2. agent_tasks: an agenda the agent keeps for itself, claimed with
//      FOR UPDATE SKIP LOCKED and `fire_at <= now()` so a minute the scheduler
//      missed still fires late instead of being skipped forever.
//
// The tick is SILENT by design. With nothing due it is two indexed queries per
// profile and returns having written nothing - no briefing, no push, no ai_runs
// row. runMidday already models this and it is the right shape: a notification
// that fires regardless of content is one the user learns to swipe away.
// ===========================================================================

// Minutes past local midnight, in the user's own zone. Reading the server's UTC
// clock here would be 5.5h out for every IST user.
function localMinutesNow(now: Date, tz: string): number {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(now);
  return jbMinutesOfDay(hm) ?? 0;
}

function localHhMm(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ms));
}

// (civil day, minutes past local midnight, zone) -> a UTC instant. jbDayWindow
// already resolves local midnight correctly for any zone; this only adds the
// minutes. The ONE place the scheduler touches a timezone at all - everything
// else is integer arithmetic on date keys.
function instantAtLocalTz(dateKey: string, minutes: number, tz: string): number {
  return Date.parse(jbDayWindow(dateKey, tz).startISO) + Math.max(0, minutes) * 60000;
}

// The claim key for one firing. A recurring task keys on its OCCURRENCE, so a
// retry of the same occurrence collides; a one-shot keys on its fire_at minute,
// never on its id alone - a re-armed task has to be able to fire again.
function taskSlotKey(task: any, tz: string): string {
  const ms = Date.parse(String(task?.fire_at || ""));
  if (!Number.isFinite(ms)) return "";
  const dayKey = jbDateKeyInTz(new Date(ms), tz);
  const hm = localHhMm(ms, tz);
  if (task.recurrence && typeof task.recurrence === "object") {
    return occurrenceKey(task.recurrence, dayKey, task.recurrence.at_time || hm) || `${dayKey}T${hm}`;
  }
  return `${dayKey}T${hm}`;
}

// When a recurring task fires next, or null when the series is finished. Chosen
// by integer arithmetic on date keys; advancing from `afterMs + 1 minute` is
// what stops a daily task re-selecting the day it just ran.
function nextFireAtFor(task: any, afterMs: number, tz: string): string | null {
  const rule = task?.recurrence;
  if (!rule || typeof rule !== "object") return null;
  if (ruleProblem(rule)) return null;
  const at = minutesOfDay(rule.at_time);
  let cursorMs = afterMs + 60000;
  for (let i = 0; i < 8; i++) {
    const day = nextOccurrence(rule, jbDateKeyInTz(new Date(cursorMs), tz));
    if (!day) return null;
    const ms = instantAtLocalTz(day, at == null ? 9 * 60 : at, tz);
    if (ms > afterMs) return new Date(ms).toISOString();
    cursorMs = instantAtLocalTz(day, 0, tz) + 86400000;
  }
  return null;
}

// Reminders whose TIME has arrived today. NOT gated on autonomy_enabled: a
// reminder the user typed themselves, firing at the minute they chose, is a
// clock - not the agent acting on its own initiative.
async function fireTimedReminders(admin: any, profile: Profile, now: Date, tz: string) {
  const all = await fetchReminders(admin, profile.id);
  const todayKey = jbDateKeyInTz(now, tz);
  const due = timedDue(all, todayKey, localMinutesNow(now, tz));
  const fired: unknown[] = [];
  for (const r of due) {
    // The INSERT is the claim. A late tick, a heartbeat and the cron all racing
    // this occurrence produce exactly one push between them.
    const won = await claimReminderFire(admin, profile.id, r.id, r.occurrence_key, "push_timed", {
      slot: "task", at_time: r.at_time,
    });
    if (!won) continue;
    const body = r.note ? `${r.title} - ${r.note}` : r.title;
    const push = await sendPush(admin, profile, r.title, String(body).slice(0, 160), now);
    fired.push({ id: r.id, title: r.title, key: r.occurrence_key, push });
  }
  return fired;
}

// The autonomy ledger, read from agent_task_runs and NEVER from ai_runs. That
// separation is the point: a self-rescheduling loop must not be able to spend
// the human's 60-calls-per-5-minutes or their $2/day and lock them out of their
// own app. An unreadable ledger fails CLOSED, same rule as the autonomy flag.
async function autonomyUsage(admin: any, userId: string) {
  const since = new Date(Date.now() - AUTONOMY_RATE_WINDOW_MIN * 60_000).toISOString();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [recent, today] = await Promise.all([
    admin.from("agent_task_runs").select("id", { count: "exact", head: true })
      .eq("user_id", userId).gte("started_at", since),
    admin.from("agent_task_runs").select("cost_usd")
      .eq("user_id", userId).gte("started_at", startOfDay.toISOString()),
  ]);
  if (recent?.error || today?.error) {
    return { runsInWindow: Number.POSITIVE_INFINITY, todayCostUsd: Number.POSITIVE_INFINITY, readable: false };
  }
  const cost = (today.data || []).reduce((acc: number, r: any) => acc + Number(r.cost_usd || 0), 0);
  return { runsInWindow: recent.count ?? 0, todayCostUsd: cost, readable: true };
}

// The unattended prompt. Every constraint the agent function's SYSTEM_PROMPT
// carries, plus the one it does not need: silence is a correct answer.
const TASK_SYSTEM = "You are the user's assistant running UNATTENDED on a schedule - nobody is watching this run, and anything you emit commits immediately. "
  + "Return ONLY a JSON object: {\"actions\":[{\"name\":\"...\",\"arguments\":{...}}]}. "
  + "You may use ONLY these tools: answer_question {answer, question, basis}, create_note_candidate {body, domain, kind}, request_user_review {reason}. "
  + "Anything else is rejected by the server. You cannot change a plan, a budget, a target or a memory fact, you cannot delete anything, and you cannot schedule another task. "
  + "Every figure you use must be copied verbatim from the FACTS JSON. NULL MEANS NOT MEASURED: say nothing at all about a null value, never render it as zero, never call it missed or skipped. "
  + "If the facts do not warrant saying anything, return {\"actions\":[]} - silence is a correct and expected answer, and it is logged as one. Do not manufacture a reason to speak. "
  + "Currency is INR; write amounts as Rs. Write with plain hyphens only - never an em dash or en dash.";

// One model call, accounted ENTIRELY on the autonomy ledger. Deliberately does
// NOT write ai_runs: that table is what the agent function's rate limiter and
// daily cap read, and a background agent must not consume either.
async function taskModel(prompt: string, facts: unknown) {
  const key = await resolveAnySecret(["DEEPSEEK_API_KEY", "NVIDIA_API_KEY"]);
  if (!key) return { calls: [], costUsd: 0, provider: "none", error: "no_model_key" };
  try {
    const url = (await resolveSecretOptional("DEEPSEEK_BASE_URL")) || DEEPSEEK_URL;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: TASK_SYSTEM },
          { role: "user", content: `TASK: ${prompt}\n\nFACTS JSON:\n${JSON.stringify(facts)}\n\nRespond with the JSON object now.` },
        ],
      }),
    });
    if (!res.ok) return { calls: [], costUsd: 0, provider: "deepseek", error: `http_${res.status}` };
    const json = await res.json();
    const usage = json.usage || {};
    const costUsd = costOf(DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD, usage.prompt_tokens, usage.completion_tokens);
    let parsed: any = null;
    try { parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}"); } catch { parsed = null; }
    const calls = Array.isArray(parsed?.actions) ? parsed.actions : [];
    return { calls, costUsd, provider: "deepseek", error: null };
  } catch (err) {
    return { calls: [], costUsd: 0, provider: "deepseek", error: String(err).slice(0, 200) };
  }
}

// Commit the calls that survived the allowlist. Every one of these is reversible
// and lands in front of the user; that is the criterion for being on the list.
async function applyAutonomousActions(admin: any, profile: Profile, task: any, calls: any[], now: Date) {
  const applied: unknown[] = [];
  let spoken = "";
  for (const call of calls) {
    const name = String(call?.name || "");
    const args = call?.arguments || {};
    if (name === "answer_question") {
      const answer = String(args.answer || "").trim();
      if (!answer) continue;
      spoken = spoken || answer;
      await admin.from("notes").insert({
        user_id: profile.id, kind: "note", domain: "general", status: "open",
        body: `[scheduled: ${String(task.prompt).slice(0, 80)}] ${answer}`.slice(0, 2000),
        occurred_at: now.toISOString(),
      }).then(() => null, () => null);
      applied.push({ name, chars: answer.length });
    } else if (name === "create_note_candidate") {
      const body = String(args.body || "").trim();
      if (!body) continue;
      await admin.from("notes").insert({
        user_id: profile.id, kind: "note", status: "open",
        domain: ["money", "diet", "gym", "wellness", "general"].includes(String(args.domain)) ? args.domain : "general",
        body: body.slice(0, 2000), occurred_at: now.toISOString(),
      }).then(() => null, () => null);
      applied.push({ name });
    } else if (name === "request_user_review") {
      await admin.from("notes").insert({
        user_id: profile.id, kind: "todo", domain: "general", status: "open",
        body: `Scheduled check needs a look: ${String(args.reason || task.prompt).slice(0, 400)}`,
        occurred_at: now.toISOString(),
      }).then(() => null, () => null);
      applied.push({ name });
    }
  }
  return { applied, spoken };
}

// Move a task on after a run: recurring rules re-arm at their next occurrence,
// one-shots are done. Advancing from max(fire_at, now) rather than from fire_at
// is deliberate - a task three days stale fires ONCE late and then resumes,
// instead of firing three more times over the next three minutes.
async function advanceTask(admin: any, task: any, now: Date, tz: string, patch: Record<string, unknown>) {
  const fromMs = Math.max(Date.parse(String(task.fire_at)) || 0, now.getTime());
  const next = nextFireAtFor(task, fromMs, tz);
  await admin.from("agent_tasks").update({
    ...patch,
    status: patch.status ?? (next ? "scheduled" : "done"),
    fire_at: next ?? task.fire_at,
    last_run_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).eq("id", task.id);
  return next;
}

async function disableTask(admin: any, task: any, now: Date, reason: string) {
  await admin.from("agent_tasks").update({
    status: "disabled", disabled_reason: reason, last_run_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq("id", task.id);
}

async function executeTask(admin: any, profile: Profile, task: any, now: Date, tz: string) {
  const zone = task.tz || tz;
  const slotKey = taskSlotKey(task, zone);
  const head = { taskId: task.id, slot: slotKey, intent: task.intent };

  // --- gates that cost nothing, in the order that costs least ---------------
  if (!slotKey) { await disableTask(admin, task, now, "unparseable fire_at"); return { ...head, blocked: "bad_fire_at" }; }
  if (!TASK_INTENTS.includes(String(task.intent || ""))) {
    await disableTask(admin, task, now, `unknown intent "${task.intent}"`);
    return { ...head, blocked: "unknown_intent" };
  }
  // A task may not create a task, and one that somehow got past the DB check
  // constraint stops here rather than being trusted.
  if (Number(task.depth || 0) > AUTONOMY_MAX_DEPTH) {
    await disableTask(admin, task, now, "depth cap: a task may not create a task");
    return { ...head, blocked: "depth_cap" };
  }
  // The circuit breaker is VISIBLE - a disabled_reason the user can read, not a
  // silent retry every minute forever.
  if (Number(task.consecutive_failures || 0) >= AUTONOMY_MAX_FAILURES) {
    await disableTask(admin, task, now, `${task.consecutive_failures} consecutive failures - switched off, re-enable in Settings`);
    return { ...head, blocked: "circuit_breaker" };
  }

  const usage = await autonomyUsage(admin, profile.id);
  if (usage.runsInWindow >= AUTONOMY_RATE_MAX || usage.todayCostUsd >= autonomyBudget(profile)) {
    // Requeued at the SAME fire_at, not advanced: hitting a budget must delay a
    // task, never silently skip its occurrence.
    await admin.from("agent_tasks").update({ status: "scheduled", updated_at: now.toISOString() }).eq("id", task.id);
    return { ...head, blocked: usage.readable ? (usage.runsInWindow >= AUTONOMY_RATE_MAX ? "autonomy_rate_limited" : "autonomy_cost_cap") : "autonomy_ledger_unreadable" };
  }

  // --- claim the RUN ROW before the model call ------------------------------
  // So a crash is distinguishable from "never ran", and so a run that produces
  // zero actions still leaves a row. A unique violation here means this exact
  // occurrence already ran - a successful no-op.
  const { data: runRow, error: runErr } = await admin.from("agent_task_runs")
    .insert({ task_id: task.id, user_id: profile.id, slot_key: slotKey, status: "claimed" })
    .select("id").single();
  if (runErr && /duplicate key|unique/i.test(runErr.message || "")) {
    await advanceTask(admin, task, now, zone, {});
    return { ...head, skipped: "already_ran" };
  }
  if (runErr) {
    await admin.from("agent_tasks").update({ status: "scheduled", updated_at: now.toISOString() }).eq("id", task.id);
    return { ...head, blocked: `run_claim_failed: ${runErr.message}` };
  }
  const runId = runRow?.id ?? null;

  const settle = async (fields: Record<string, unknown>, failed: boolean) => {
    if (runId) {
      await admin.from("agent_task_runs").update({ ...fields, finished_at: new Date().toISOString() }).eq("id", runId);
    }
    const fails = failed ? Number(task.consecutive_failures || 0) + 1 : 0;
    // The breaker trips HERE, on the failure that reaches the limit - not on the
    // next attempt. Waiting a tick would mean one more run of a task that has
    // already failed three times in a row, and the user seeing nothing until
    // then. Re-enabling from Settings clears the count.
    if (fails >= AUTONOMY_MAX_FAILURES) {
      await admin.from("agent_tasks").update({
        status: "disabled", consecutive_failures: fails,
        disabled_reason: `${fails} consecutive failures - switched off, re-enable in Settings`,
        runs: Number(task.runs || 0) + 1, last_run_at: now.toISOString(), updated_at: now.toISOString(),
      }).eq("id", task.id);
      return;
    }
    await advanceTask(admin, task, now, zone, {
      runs: Number(task.runs || 0) + 1,
      consecutive_failures: fails,
    });
  };

  try {
    const todayKey = jbDateKeyInTz(now, zone);

    // "remind" never involves a model at all - it is a note-to-self with a clock
    // on it, and running a model over it would be spend with no decision in it.
    if (task.intent === "remind") {
      const push = await sendPush(admin, profile, "Reminder", String(task.prompt).slice(0, 160), now);
      await settle({ status: "spoke", result: String(task.prompt).slice(0, 400), actions: 0 }, false);
      return { ...head, status: "spoke", push };
    }

    // Today's real numbers, the same ones the midday slot uses.
    const win = jbDayWindow(todayKey, zone);
    const [rows, budgets, gymPayload] = await Promise.all([
      fetchDayRows(admin, profile.id, win.startISO, now.toISOString()),
      fetchBudgets(admin, profile.id),
      fetchGymPayload(admin, profile.id),
    ]);
    const planned = jbPlannedWorkout(jbWeekdayFromKey(todayKey), gymPayload);
    const sofar = jbCloseDay({ ...rows, budgets, plannedKind: planned.kind });
    const hoursLeftInDay = Math.max(0, (24 * 60 - localMinutesNow(now, zone)) / 60);

    // "check" is DETERMINISTIC and free. jbMiddayBody returns a null body on a
    // day that is on track, and that is a real outcome with a row of its own -
    // not an early return that leaves no trace of the run having happened.
    if (task.intent === "check") {
      const check = jbMiddayBody({
        proteinTarget: sofar.caps.proteinTarget, proteinToday: sofar.protein,
        caloriesTarget: sofar.caps.caloriesTarget, caloriesToday: sofar.calories,
        mealsLogged: (rows.foods || []).length,
        plannedKind: planned.kind, plannedName: planned.name, workoutLogged: sofar.workoutDone,
        spendCap: sofar.caps.spendCap, todaySpend: sofar.spend,
        hoursLeftInDay,
      });
      if (!check.body) {
        await settle({ status: "silent", result: "silent: on track", actions: 0 }, false);
        return { ...head, status: "silent" };
      }
      const push = await sendPush(admin, profile, String(task.prompt).slice(0, 60) || "Scheduled check", check.body, now);
      await settle({ status: "spoke", result: check.body.slice(0, 400), actions: 0 }, false);
      return { ...head, status: "spoke", push };
    }

    // "answer" / "review": the only paths that spend anything.
    const facts = {
      for_date: todayKey,
      weekday: JB_WEEKDAY_NAMES[jbWeekdayFromKey(todayKey)],
      today: {
        spend: sofar.spend, protein: sofar.protein, calories: sofar.calories,
        meals_logged: (rows.foods || []).length, workout_done: sofar.workoutDone,
        sleep_h: sofar.sleepH, weight_kg: sofar.weightKg,
      },
      targets: sofar.caps,
      planned_workout: planned.name,
      hours_left_in_day: Math.round(hoursLeftInDay * 10) / 10,
    };
    const out = await taskModel(String(task.prompt), facts);
    const { allowed, blocked } = filterAutonomousActions(out.calls, Number(task.depth || 0));
    const hash = actionHash(allowed);

    // The loop detector runs AFTER the call (the hash is only knowable then) and
    // BEFORE anything commits. Three identical action sets in a day is a loop,
    // not a schedule, and the task is switched off with a readable reason.
    const { data: priorRuns } = await admin.from("agent_task_runs")
      .select("action_hash, started_at").eq("task_id", task.id)
      .gte("started_at", new Date(now.getTime() - AUTONOMY_LOOP_WINDOW_H * 3600_000).toISOString());
    const loopHits = (priorRuns || []).filter((r: any) => r.action_hash && r.action_hash === hash).length;
    if (hash && allowed.length && loopHits >= AUTONOMY_LOOP_REPEATS) {
      if (runId) {
        await admin.from("agent_task_runs").update({
          status: "blocked", result: `action_loop: same ${allowed.length} action(s) ${loopHits + 1}x in ${AUTONOMY_LOOP_WINDOW_H}h`,
          action_hash: hash, cost_usd: out.costUsd, finished_at: new Date().toISOString(),
        }).eq("id", runId);
      }
      await disableTask(admin, task, now, `switched off: it emitted the same actions ${loopHits + 1} times in ${AUTONOMY_LOOP_WINDOW_H}h`);
      return { ...head, status: "blocked", reason: "action_loop" };
    }

    if (out.error && !allowed.length) {
      await settle({ status: "failed", result: `model: ${out.error}`, action_hash: hash, cost_usd: out.costUsd, error: out.error }, true);
      return { ...head, status: "failed", error: out.error };
    }
    if (!allowed.length) {
      await settle({
        status: blocked.length ? "blocked" : "silent",
        result: blocked.length ? `blocked: ${blocked.map((b: any) => `${b.name}=${b.reason}`).join(", ")}`.slice(0, 400) : "silent: nothing worth saying",
        action_hash: hash, cost_usd: out.costUsd, actions: 0,
      }, false);
      return { ...head, status: blocked.length ? "blocked" : "silent", blocked };
    }

    const { applied, spoken } = await applyAutonomousActions(admin, profile, task, allowed, now);
    let push: unknown = null;
    if (spoken) push = await sendPush(admin, profile, String(task.prompt).slice(0, 60) || "Scheduled check", spoken.slice(0, 160), now);
    await settle({
      status: "spoke", result: (spoken || `${applied.length} action(s)`).slice(0, 400),
      action_hash: hash, cost_usd: out.costUsd, actions: applied.length,
    }, false);
    await auditLog(admin, profile.id, "jarvis.task", { taskId: task.id, slot: slotKey, applied, blocked, cost: out.costUsd });
    return { ...head, status: "spoke", applied, blocked, push };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await settle({ status: "failed", result: message.slice(0, 400), error: message.slice(0, 400) }, true);
    return { ...head, status: "failed", error: message };
  }
}

async function runTask(admin: any, profile: Profile, now: Date, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";

  // 1. Timed reminders. A failed read here must NOT look like "nothing was due"
  //    - that is the exact computed-then-never-surfaced shape this codebase
  //    keeps rediscovering - so it is reported alongside the task results.
  let reminders: unknown[] = [];
  let reminderError: string | null = null;
  try {
    reminders = await fireTimedReminders(admin, profile, now, tz);
  } catch (err) {
    reminderError = err instanceof Error ? err.message : String(err);
  }

  // 2. agent_tasks, behind the autonomy flag - read server-side, FIRST, failing
  //    CLOSED. A client flag cannot stop a server-side agent.
  const perm = autonomyAllowed(profile);
  if (!perm.allowed) {
    return { userId: profile.id, action: "task", reminders, tasks: [], skipped: perm.reason, reminderError };
  }

  const { data: claimed, error } = await admin.rpc("claim_agent_tasks", {
    p_user: profile.id, p_limit: AUTONOMY_MAX_PER_TICK,
  });
  if (error) throw new Error(`claim_agent_tasks failed: ${error.message}`);

  const tasks: unknown[] = [];
  for (const task of claimed || []) {
    // force re-runs an occurrence that already has a run row, for diagnostics.
    if (force) await admin.from("agent_task_runs").delete().eq("task_id", task.id).eq("slot_key", taskSlotKey(task, task.tz || tz));
    tasks.push(await executeTask(admin, profile, task, now, tz));
  }
  return { userId: profile.id, action: "task", reminders, tasks, reminderError };
}

async function runStatus(admin: any, profile: Profile) {
  const { data: latest } = await admin.from("briefings")
    .select("kind, for_date, created_at, seen")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false }).limit(6);
  const { count: pushCount } = await admin.from("push_subscriptions")
    .select("id", { count: "exact", head: true }).eq("user_id", profile.id);
  return {
    userId: profile.id,
    action: "status",
    latest: latest || [],
    pushSubscriptions: pushCount ?? 0,
    config: {
      resend: Boolean(await resolveSecretOptional("RESEND_API_KEY")),
      vapid: Boolean(await resolveSecretOptional("JARVIS_VAPID_JWK")),
      cronSecret: Boolean(await resolveSecretOptional("JARVIS_CRON_SECRET")),
      deepseek: Boolean(await resolveAnySecret(["DEEPSEEK_API_KEY", "NVIDIA_API_KEY"])),
      gemini: Boolean(await resolveSecretOptional("GEMINI_API_KEY")),
    },
  };
}

// -------- handler --------

Deno.serve(async (req) => {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-jarvis-secret",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const payload = await req.json().catch(() => ({}));
    const action = String(payload?.action || "");
    const force = Boolean(payload?.force);
    // ACTION ALLOWLIST - must list every action the dispatch loop below can run.
    // "midday" was missing from it while runMidday sat wired up ~35 lines further
    // down, so the 14:30 IST pg_cron slot and the GitHub heartbeat had BOTH been
    // getting a 400 unknown_action since the slot was built: the protein/gym pace
    // nudge has never once fired. tests/jarvis-actions.test.mjs now compares this
    // list against the handlers the loop actually dispatches, as sets.
    // "task" is the per-minute tick (20260806000030): timed reminders plus the
    // agent_tasks agenda. Adding an action WITHOUT adding it here is exactly how
    // midday spent weeks 400ing, so tests/jarvis-actions.test.mjs compares this
    // list, the dispatch loop, pg_cron and the GitHub heartbeat as sets.
    if (!["closeout", "morning", "midday", "evening", "status", "task"].includes(action)) {
      return Response.json({ ok: false, error: "unknown_action" }, { status: 400, headers: corsHeaders });
    }

    const admin = adminClient();
    const now = new Date();

    // Auth: cron secret runs every enabled user; a user JWT runs only itself.
    let profiles: Profile[] = [];
    const cronSecret = await resolveSecretOptional("JARVIS_CRON_SECRET");
    const headerSecret = req.headers.get("x-jarvis-secret") || "";
    if (cronSecret && headerSecret && safeEqual(headerSecret, cronSecret)) {
      const { data, error } = await admin.from("profiles").select("*").eq("briefing_enabled", true);
      if (error) return Response.json({ ok: false, error: `profiles read failed: ${error.message}` }, { status: 500, headers: corsHeaders });
      // Skip fixture accounts. An abandoned E2E signup (e2e_*@test.local) was
      // still a live profile row, so every slot ran the whole brief pipeline
      // twice - doubling LLM spend and firing Resend at an address that cannot
      // exist, which risks the sender reputation the real brief depends on.
      profiles = (data || []).filter((p: Profile) => !isFixtureProfile(p));
    } else {
      const auth = req.headers.get("authorization") || "";
      const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!jwt) return Response.json({ ok: false, error: "missing_auth" }, { status: 401, headers: corsHeaders });
      const { data: userResp, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userResp?.user?.id) {
        return Response.json({ ok: false, error: "invalid_auth" }, { status: 401, headers: corsHeaders });
      }
      const { data: prof } = await admin.from("profiles").select("*").eq("id", userResp.user.id).maybeSingle();
      if (prof) profiles = [prof];
    }

    const results: unknown[] = [];
    for (const profile of profiles) {
      // SLOT CLAIM. pg_cron is the primary clock and the GitHub heartbeat
      // re-fires the same actions minutes later; they are meant to COLLIDE. Each
      // of the four daily slots already re-checks its own briefings row, but
      // that check happens AFTER the reads and the LLM call, so a collision was
      // still paying for a brief it then threw away. The lease means a run that
      // crashed mid-flight releases the slot after 10 minutes instead of wedging
      // it. `task` is deliberately exempt: its claims are per-occurrence rows in
      // reminder_fires / agent_task_runs, which are finer than a minute slot.
      const tz = profile.timezone || "Asia/Kolkata";
      const slotKey = action === "closeout"
        ? jbAddDays(jbDateKeyInTz(now, tz), -1)
        : jbDateKeyInTz(now, tz);
      const needsSlot = action !== "status" && action !== "task" && !force;
      if (needsSlot && !(await claimJob(admin, profile.id, `jarvis_${action}`, slotKey, 600))) {
        results.push({ userId: profile.id, action, skipped: "slot_claimed_elsewhere", slot: slotKey });
        continue;
      }
      let slotStatus = "done";
      try {
        if (action === "status") { results.push(await runStatus(admin, profile)); continue; }
        if (action === "task") { results.push(await runTask(admin, profile, now, force)); continue; }
        if (action === "morning") { results.push(await runMorning(admin, profile, now, force)); continue; }
        if (action === "evening") { results.push(await runEvening(admin, profile, now, force)); continue; }
        if (action === "midday") { results.push(await runMidday(admin, profile, now, force)); continue; }
        // closeout: close the most recently ENDED local day (at 00:05 IST that is
        // yesterday); an explicit payload.date closes that civil day instead.
        const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date || ""))
          ? String(payload.date)
          : jbAddDays(jbDateKeyInTz(now, tz), -1);
        results.push(await runCloseout(admin, profile, dateKey, force));
      } catch (err) {
        // A FAILED slot must stay retryable. Marking it done would mean one
        // transient Supabase blip permanently costs that day its brief, which is
        // the whole reason the heartbeat exists.
        slotStatus = "failed";
        results.push({ userId: profile.id, action, ok: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (needsSlot) await finishJob(admin, profile.id, `jarvis_${action}`, slotKey, slotStatus, { action });
      }
    }

    return Response.json({ ok: true, action, users: profiles.length, results }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
