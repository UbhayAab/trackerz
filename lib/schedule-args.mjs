// TURNING A SENTENCE INTO A CALENDAR ROW.
//
// The engine that computes occurrences (lib/reminders.mjs) has understood
// intervals, nth-weekdays, multi-weekday rules, UNTIL, COUNT and times of day
// since Phase 6. The AGENT could not write any of them. So "every other
// Wednesday at 18:30" was stored as a plain weekly rule with no hour: it fired
// on the wrong week, at the wrong time, and said nothing about having dropped
// half the sentence. That is this codebase's signature failure - a value
// computed correctly one layer away from where it was needed - and this module
// is the connecting piece.
//
// Two shapes come out of here:
//   reminderColumns() - a `reminders` row. Pure rule PARTS; no instant is
//                       computed, because jarvis owns occurrence arithmetic.
//   taskRow()         - an `agent_tasks` row, which DOES need an instant,
//                       because `fire_at` is what the every-minute claim query
//                       compares against.
//
// Pure: no DOM, no Supabase, no clock (every entry point takes `today`).
// Mirrored into supabase/functions/agent/index.ts.

// ==== SCHEDULE-ARGS MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====

// "3TU" = third Tuesday, "-1FR" = last Friday. RFC 5545 BYDAY, minus the comma
// list we deliberately do not accept from a model.
var NTH_WEEKDAY_RE = /^-?[1-5](SU|MO|TU|WE|TH|FR|SA)$/;
var SA_DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * The RFC form a model naturally writes, split into the two integers the
 * database and lib/reminders.mjs actually use.
 *
 * `reminders.nth_weekday` is an `int` column and the engine reads the weekday
 * from the SEPARATE weekday/weekdays field. Sending "-1FR" straight through
 * would have failed the insert on a type error. Accepting both forms and
 * normalising here is strictly better than forbidding the ergonomic one: the
 * model writes what it would write anyway, and exactly one shape reaches the DB.
 */
function parseNthWeekday(v) {
  if (v == null || v === "") return { nth: null, weekday: null };
  const n = typeof v === "number" ? v : (/^-?\d+$/.test(String(v).trim()) ? Number(v) : null);
  if (n !== null) {
    return Number.isInteger(n) && n !== 0 && n >= -5 && n <= 5
      ? { nth: n, weekday: null }
      : { nth: null, weekday: null };
  }
  const s = String(v).trim().toUpperCase();
  if (!NTH_WEEKDAY_RE.test(s)) return { nth: null, weekday: null };
  return { nth: Number(s.slice(0, -2)), weekday: SA_DAY_CODES.indexOf(s.slice(-2)) };
}

// Evidence that SCHEDULING was asked for. The prompt of a scheduled task is
// written BY the model, so it can never be required to echo the user's words -
// grounding here has to be about the ACT, not the content. Without this a
// hallucinated task is a push notification at 9am about something nobody asked
// for, which is the most expensive kind of wrong this app can be.
var SCHEDULE_CUE = /\b(schedul|remind|check (on|in|at|whether|if)|tell me (on|at|in|later|tomorrow|next)|every (day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|other|[0-9])|each (day|week|month)|tomorrow|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at [0-9]{1,2}\s*(am|pm|:)|daily|weekly|monthly|later today|end of (the )?(day|week|month))/i;

var SA_DAY = 86400000;

// The COUNT ceiling, in ONE place.
//
// This was 500 here while `reminders_max_count_check` in the database allows
// 1..400. A model emitting count 450 therefore passed this clamp cleanly and
// then died on the check constraint, taking the whole capture down with it - a
// validator that accepts what the next layer rejects is worse than no validator,
// because it moves the failure somewhere nobody is reading.
//
// tests/schedule-args.test.mjs reads the number back out of the migration and
// fails if the two ever disagree again.
var SA_MAX_COUNT = 400;

/** "18:30" / "6:30 pm" / "0930" -> "HH:MM", or null. */
function hhmm(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\s*(?::\s*(\d{2}))?\s*(am|pm)?$/) || s.match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[3];
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** An integer inside [lo, hi], or null. Never coerces a bad value to a bound. */
function clampInt(v, lo, hi) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= lo && i <= hi ? i : null;
}

/** A real YYYY-MM-DD, checked against the calendar (2026-02-30 is not one). */
function isDateKey(v) {
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Day-key arithmetic through UTC midnight, which has no DST to fall into.
 *
 * The key is assembled from UTC parts rather than sliced off an ISO string.
 * Same answer here, because the input is already a bare date at midnight - but
 * the sliced form is the shape tests/tz.test.mjs bans on sight, and an
 * exception that has to be explained every time it is read is worth four lines
 * of arithmetic to avoid.
 */
function saAddDays(key, n) {
  const [y, m, d] = String(key).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * SA_DAY);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** 0=Sunday, matching the `weekday` column and JS getUTCDay. */
function saWeekdayOf(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Wall-clock offset of `tz` at a given instant, in ms. Derived from Intl rather
// than hardcoded to +05:30 so that a user in another zone is not silently
// scheduled 5.5 hours off - the cost is one formatToParts.
function saOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - utcMs;
}

// The read direction. lib/tz.mjs owns these for the browser; the agent function
// cannot import it, so the mirror carries its own pair and
// tests/schedule-args.test.mjs asserts they agree with lib/tz.mjs across a year
// of instants. A duplicate that is checked is a cache; one that is not is a bug
// waiting for the day the two answers differ.
var SA_DEFAULT_TZ = "Asia/Kolkata";

/** YYYY-MM-DD for an instant, in `tz`. Never the UTC-sliced form. */
function saDayKey(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || SA_DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** Minutes since local midnight for an instant, in `tz`. */
function saMinuteOfDay(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || SA_DEFAULT_TZ, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  return (g("hour") % 24) * 60 + g("minute");
}

/**
 * A local wall time in `tz` as a UTC ISO instant.
 *
 * Two passes: the first offset is read at the wrong instant by up to the offset
 * itself, which only matters within a few hours of a DST transition - and India
 * has none, so the second pass is here for the zones this will meet later.
 */
function zonedToUtcIso(dayKey, time, tz) {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  const [h, mi] = String(time || "09:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h || 0, mi || 0);
  let ms = guess - saOffsetMs(guess, tz);
  ms = guess - saOffsetMs(ms, tz);
  return new Date(ms).toISOString();
}

/**
 * Drop every key whose value is null, because these objects are INSERT payloads.
 *
 * `reminders.rule_interval` is NOT NULL DEFAULT 1. Sending an explicit null
 * OVERRIDES the default and violates the constraint, so every reminder the agent
 * wrote failed - and the failure was invisible: the edge function reads a write
 * that returned no row as "contract failure, demote to proposed", discards the
 * error, and the owner sees a growing list of things "pending review" with no
 * reason attached. That is what "why are there so many pending, why is it not
 * automatic" turned out to be.
 *
 * Omitting is never worse than sending null: a nullable column with no default
 * ends up null either way, and a defaulted column gets its default.
 */
function dropNulls(row) {
  const out = {};
  for (const k of Object.keys(row)) if (row[k] !== null && row[k] !== undefined) out[k] = row[k];
  return out;
}

/**
 * The `reminders` columns for one create_reminder_candidate call.
 *
 * Returns rule PARTS only. Nothing here decides WHEN it fires - that is
 * lib/reminders.mjs, running inside jarvis, and keeping the decision in exactly
 * one place is why a reminder written by the agent and one written by hand
 * cannot behave differently.
 */
function reminderColumns(args, opts) {
  const a = args || {};
  const o = opts || {};
  const today = o.today || "1970-01-01";
  const kind = a.kind || "task";
  const weekdays = Array.isArray(a.weekdays)
    ? a.weekdays.map((d) => clampInt(d, 0, 6)).filter((d) => d !== null)
    : null;
  const interval = clampInt(a.interval, 1, 52);
  const onDate = isDateKey(a.on_date) ? String(a.on_date) : null;
  const nth = parseNthWeekday(a.nth_weekday);
  // "last Friday" carries its own weekday. Only borrow it when the model did not
  // say one outright - an explicit weekday is the more direct statement of the
  // two and must win.
  const weekday = clampInt(a.weekday, 0, 6) ?? ((weekdays && weekdays.length) ? null : nth.weekday);
  return dropNulls({
    title: String(a.title || "").slice(0, 200),
    note: a.note ? String(a.note).slice(0, 500) : null,
    kind,
    freq: String(a.freq || "").toLowerCase(),
    day_of_month: clampInt(a.day_of_month, 1, 31),
    month_of_year: clampInt(a.month_of_year, 1, 12),
    weekday,
    on_date: onDate,
    // A filing wants a week of warning, a birthday a day. Default by kind rather
    // than 0, because a same-day-only tax reminder is useless.
    lead_days: clampInt(a.lead_days, 0, 60) ?? (kind === "filing" || kind === "bill" ? 7 : kind === "birthday" || kind === "anniversary" ? 2 : 0),
    at_time: hhmm(a.at_time),
    rule_interval: interval,
    weekdays: weekdays && weekdays.length ? weekdays : null,
    nth_weekday: nth.nth,
    until: isDateKey(a.until) ? String(a.until) : null,
    max_count: clampInt(a.count, 1, SA_MAX_COUNT),
    // An interval rule needs a phase. Anchor it to what was said, else to the
    // first occurrence, else to today - never null, because a null anchor makes
    // "every other week" mean "whichever week the server evaluates it in".
    dtstart: isDateKey(a.dtstart) ? String(a.dtstart) : (onDate || today),
    timezone: o.tz || "Asia/Kolkata",
  });
}

/**
 * The first day this rule can fire, at or after `today`.
 *
 * Deliberately narrow: it answers "when is the FIRST one", not "when is the
 * next one after that". The every-minute runner re-arms recurrences through the
 * full engine, so anything cleverer here would be a second implementation of
 * occurrence arithmetic - and the one bug this whole phase exists to fix was two
 * layers disagreeing about a date.
 */
function firstFireKey(a, today) {
  if (isDateKey(a.on_date) && String(a.on_date) >= today) return String(a.on_date);
  const freq = String(a.freq || "once").toLowerCase();
  const wds = Array.isArray(a.weekdays)
    ? a.weekdays.map((d) => clampInt(d, 0, 6)).filter((d) => d !== null)
    : [];
  const wd = clampInt(a.weekday, 0, 6);
  const want = wds.length ? wds : (wd !== null ? [wd] : []);
  if (want.length) {
    for (let i = 0; i < 7; i++) {
      const k = saAddDays(today, i);
      if (want.indexOf(saWeekdayOf(k)) >= 0) return k;
    }
  }
  const dom = clampInt(a.day_of_month, 1, 31);
  if (dom !== null) {
    // Walk forward a day at a time rather than constructing a date: it lands on
    // the right month with no clamping question, and 62 iterations is nothing.
    for (let i = 0; i < 62; i++) {
      const k = saAddDays(today, i);
      if (Number(k.slice(8, 10)) === dom) return k;
    }
  }
  if (freq === "once" && isDateKey(a.on_date)) return String(a.on_date);
  return today;
}

/**
 * The `agent_tasks` row for one schedule_task_candidate call.
 *
 * `nowMinutes` is minutes-since-local-midnight at write time. It exists for one
 * case: "check at 3pm" said at 4pm means TOMORROW at 3pm. Firing it three
 * seconds later, on a schedule the user just set for the future, is the kind of
 * wrong that makes someone turn the feature off.
 */
function taskRow(args, opts) {
  const a = args || {};
  const o = opts || {};
  const today = o.today || "1970-01-01";
  const tz = o.tz || "Asia/Kolkata";
  const time = hhmm(a.at_time) || "09:00";
  const freq = String(a.freq || "once").toLowerCase();

  let key = firstFireKey(a, today);
  const timed = hhmm(a.at_time) !== null;
  const explicitDay = isDateKey(a.on_date) || clampInt(a.weekday, 0, 6) !== null
    || (Array.isArray(a.weekdays) && a.weekdays.length) || clampInt(a.day_of_month, 1, 31) !== null;
  const past = timed && typeof o.nowMinutes === "number"
    && (Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))) <= o.nowMinutes;
  if (key === today && past && !explicitDay) key = saAddDays(today, 1);

  const weekdays = Array.isArray(a.weekdays)
    ? a.weekdays.map((d) => clampInt(d, 0, 6)).filter((d) => d !== null)
    : null;

  return dropNulls({
    fire_at: zonedToUtcIso(key, time, tz),
    tz,
    recurrence: freq === "once" ? null : {
      freq,
      weekday: clampInt(a.weekday, 0, 6),
      weekdays: weekdays && weekdays.length ? weekdays : null,
      day_of_month: clampInt(a.day_of_month, 1, 31),
      interval: clampInt(a.interval, 1, 52),
      until: isDateKey(a.until) ? String(a.until) : null,
      count: clampInt(a.count, 1, SA_MAX_COUNT),
      at_time: time,
      dtstart: key,
    },
    intent: ["check", "answer", "remind", "review"].indexOf(String(a.intent)) >= 0 ? String(a.intent) : "check",
    prompt: String(a.prompt || "").slice(0, 2000),
  });
}
// ==== SCHEDULE-ARGS MIRROR END ====

export {
  NTH_WEEKDAY_RE, SCHEDULE_CUE, hhmm, clampInt, isDateKey,
  saAddDays, saWeekdayOf, saDayKey, saMinuteOfDay, zonedToUtcIso, SA_DEFAULT_TZ, parseNthWeekday,
  SA_MAX_COUNT,
  reminderColumns, firstFireKey, taskRow,
};
