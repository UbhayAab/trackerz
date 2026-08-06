// ONE timezone truth for the whole app.
//
// The incident this file exists for: `new Date(x).toISOString().slice(0, 10)` was
// the day key in at least six modules. IST is UTC+5:30, so every instant from
// 18:30 UTC onward already belongs to TOMORROW in Asia/Kolkata. A dinner logged
// at 00:30 IST Saturday is 19:00 UTC Friday, and the UTC slice calls it Friday.
// A consistent Friday-night-into-Saturday habit would then be reported to the
// user, in a sentence, as "every Friday" - off by one, confidently, forever.
// Measured on the live DB 2026-08-06:
//   select count(*) from workout_logs
//   where (occurred_at at time zone 'Asia/Kolkata')::date <> occurred_at::date;
//   -> 2
// Two rows out of eighteen already disagree. The bug is not theoretical and it
// grows with every late-evening capture.
//
// Pure: no DOM, no Supabase, no clock reads except an injected `now`. Intl only,
// so it is correct for any zone, not just the one with no DST.

export const DEFAULT_TZ = "Asia/Kolkata";

const DAY_MS = 86400000;

// Weekday names indexed the way JS indexes them: 0 = Sunday.
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Intl formatters are expensive to build and this module is called once per row
// over thousands of rows. One cache per (locale, zone, shape).
const FORMATTERS = new Map();
function formatter(timeZone, opts, tag) {
  const cacheKey = `${tag}|${timeZone}`;
  let f = FORMATTERS.get(cacheKey);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hour12: false, ...opts });
    FORMATTERS.set(cacheKey, f);
  }
  return f;
}

// Accepts a Date, an epoch-ms number, or any parseable ISO string. Throws rather
// than returning a silent fallback: a NaN day key becomes the string "Invalid
// Date" downstream and lands in a group of its own, which is exactly the class
// of bug ("absent data rendered as measured") this codebase keeps re-fixing.
export function toInstantMs(value, what = "instant") {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new TypeError(`tz: invalid Date for ${what}`);
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`tz: invalid epoch ms for ${what}`);
    return value;
  }
  const ms = Date.parse(String(value == null ? "" : value));
  if (!Number.isFinite(ms)) throw new TypeError(`tz: unparseable timestamp for ${what}: ${String(value)}`);
  return ms;
}

function partsInTz(ms, timeZone) {
  const parts = formatter(timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }, "full").formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  // Some ICU builds render midnight as hour 24 rather than 0.
  if (out.hour === 24) out.hour = 0;
  return out;
}

// "YYYY-MM-DD" for the calendar day this instant falls on IN `timeZone`.
export function dayKeyInTz(instant, timeZone = DEFAULT_TZ) {
  const p = partsInTz(toInstantMs(instant, "dayKeyInTz"), timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// 0..23 local hour. The hour-by-hour half of the pattern engine reads this; it
// must never be `new Date(x).getUTCHours()`, which puts a 21:00 IST dinner at 15.
export function hourInTz(instant, timeZone = DEFAULT_TZ) {
  return partsInTz(toInstantMs(instant, "hourInTz"), timeZone).hour;
}

// 0..1439. The unit the circular median works in.
export function minuteOfDayInTz(instant, timeZone = DEFAULT_TZ) {
  const p = partsInTz(toInstantMs(instant, "minuteOfDayInTz"), timeZone);
  return p.hour * 60 + p.minute;
}

// 0 = Sunday .. 6 = Saturday, in `timeZone`.
export function weekdayInTz(instant, timeZone = DEFAULT_TZ) {
  const short = formatter(timeZone, { weekday: "short" }, "wd").format(new Date(toInstantMs(instant, "weekdayInTz")));
  const idx = WEEKDAY_INDEX[short.slice(0, 3)];
  if (idx === undefined) throw new Error(`tz: unrecognised weekday "${short}" for zone ${timeZone}`);
  return idx;
}

// Offset (ms) to ADD to a UTC instant to get the zone's wall-clock reading.
// Derived by formatting the instant in the zone and re-reading those wall-clock
// fields as if they were UTC; the difference is the offset at that instant.
function zoneOffsetMs(ms, timeZone) {
  const p = partsInTz(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

// Epoch-ms bounds of a local calendar day: [startMs, endMs), endMs exclusive.
// Two-pass because the offset must be evaluated AT the answer, not at the guess -
// on a DST-shifting zone the first guess can land on the wrong side of the jump.
// Asia/Kolkata has no DST, so the second pass is a no-op there; it is here so
// this function is not quietly wrong the day someone reuses it for Europe/London.
export function dayBoundsInTz(dayKey, timeZone = DEFAULT_TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ""));
  if (!m) throw new TypeError(`tz: dayBoundsInTz expects a YYYY-MM-DD key, got ${String(dayKey)}`);
  const wallMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let startMs = wallMs - zoneOffsetMs(wallMs, timeZone);
  startMs = wallMs - zoneOffsetMs(startMs, timeZone);
  let endWall = wallMs + DAY_MS;
  let endMs = endWall - zoneOffsetMs(endWall, timeZone);
  endMs = endWall - zoneOffsetMs(endMs, timeZone);
  return { startMs, endMs, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

// The instant a given local wall-clock time on a given local day corresponds to.
// Used by the nudge scheduler: "2 hours before the usual 20:10 IST" has to become
// a real UTC instant to be queued.
export function instantAtLocal(dayKey, minuteOfDay, timeZone = DEFAULT_TZ) {
  const { startMs } = dayBoundsInTz(dayKey, timeZone);
  const wall = startMs + Math.round(minuteOfDay) * 60000;
  // Re-solve the offset at the target minute so a mid-day DST jump is honoured.
  const drift = zoneOffsetMs(wall, timeZone) - zoneOffsetMs(startMs, timeZone);
  return wall - drift;
}

// Day keys are pure strings, so arithmetic on them goes through UTC midnight
// where every day is exactly 24h - never through the local zone, where a DST day
// is 23 or 25 hours and `+ 86400000` skips or repeats a date.
export function addDays(dayKey, n) {
  const base = Date.parse(`${dayKey}T00:00:00Z`);
  if (!Number.isFinite(base)) throw new TypeError(`tz: addDays got a bad key: ${String(dayKey)}`);
  return new Date(base + n * DAY_MS).toISOString().slice(0, 10); // tz-allowlist: pure UTC-midnight key arithmetic, no zone involved
}

export function dayDiff(fromKey, toKey) {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

// ISO-8601 week key, "2026-W32". The pattern engine's span floor counts DISTINCT
// ISO weeks, not distinct days: three pizza slices on one Saturday evening are
// three rows, one day and one week, and must never read as three Saturdays.
export function isoWeekKeyInTz(instant, timeZone = DEFAULT_TZ) {
  const key = dayKeyInTz(instant, timeZone);
  const d = new Date(`${key}T00:00:00Z`);
  // ISO weeks run Monday..Sunday and belong to the year containing their Thursday.
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// "20:10" from a minute-of-day. One place, so nudge copy and pattern evidence
// cannot format the same number two ways.
export function hhmm(minuteOfDay) {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export default {
  DEFAULT_TZ, WEEKDAY_NAMES, dayKeyInTz, hourInTz, minuteOfDayInTz, weekdayInTz,
  dayBoundsInTz, instantAtLocal, addDays, dayDiff, isoWeekKeyInTz, hhmm, toInstantMs,
};
