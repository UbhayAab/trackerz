// TIMEZONE tests - and the lint that stops the bug coming back.
//
// The bug: `new Date(x).toISOString().slice(0, 10)` as a day key. IST is UTC+5:30
// so everything from 18:30 UTC onward is already tomorrow in Asia/Kolkata, and a
// consistent Friday-night-into-Saturday habit gets reported to the user, in a
// sentence, as "every Friday". Confirmed against the live DB 2026-08-06:
//   select count(*) from workout_logs
//   where (occurred_at at time zone 'Asia/Kolkata')::date <> occurred_at::date;
//   -> 2 rows already disagree, out of 18.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  DEFAULT_TZ, dayKeyInTz, hourInTz, minuteOfDayInTz, weekdayInTz, dayBoundsInTz,
  instantAtLocal, addDays, dayDiff, isoWeekKeyInTz, hhmm, toInstantMs, WEEKDAY_NAMES,
} from "../lib/tz.mjs";

let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };

// --- the exact instant the old code got wrong -------------------------------
{
  // 2026-08-07 is a Friday. 19:00 UTC that day is 00:30 IST on SATURDAY 8 Aug.
  const iso = "2026-08-07T19:00:00.000Z";
  eq(new Date(iso).toISOString().slice(0, 10), "2026-08-07", "sanity: the UTC slice says Friday"); // tz-allowlist: this line IS the bug, quoted as evidence
  eq(dayKeyInTz(iso, DEFAULT_TZ), "2026-08-08", "IST day key must be Saturday");
  eq(WEEKDAY_NAMES[new Date(iso).getUTCDay()], "Friday", "UTC weekday is Friday");
  eq(WEEKDAY_NAMES[weekdayInTz(iso, DEFAULT_TZ)], "Saturday", "IST weekday is Saturday - the off-by-one the user would have read");
  eq(hourInTz(iso, DEFAULT_TZ), 0, "00:30 IST");
  eq(minuteOfDayInTz(iso, DEFAULT_TZ), 30, "minute of day 30");
}

// 18:30 UTC is the exact boundary in IST: 18:29 is still today, 18:30 is tomorrow.
{
  eq(dayKeyInTz("2026-08-07T18:29:59.999Z", DEFAULT_TZ), "2026-08-07", "one ms before the boundary");
  eq(dayKeyInTz("2026-08-07T18:30:00.000Z", DEFAULT_TZ), "2026-08-08", "at the boundary");
  eq(hourInTz("2026-08-07T18:30:00.000Z", DEFAULT_TZ), 0, "midnight, not hour 24");
}

// --- a whole day, hour by hour, must produce exactly one day key change ------
{
  const keys = new Set();
  for (let h = 0; h < 24; h++) keys.add(dayKeyInTz(`2026-08-07T${String(h).padStart(2, "0")}:00:00Z`, DEFAULT_TZ));
  eq(keys.size, 2, "a UTC day spans exactly two IST days");
}

// --- input shapes ------------------------------------------------------------
{
  const ms = Date.parse("2026-08-07T19:00:00Z");
  eq(dayKeyInTz(ms, DEFAULT_TZ), "2026-08-08", "epoch ms accepted");
  eq(dayKeyInTz(new Date(ms), DEFAULT_TZ), "2026-08-08", "Date accepted");
  eq(toInstantMs(ms), ms, "toInstantMs passthrough");
  // A bad timestamp must THROW, not silently become a day key of its own. A
  // NaN group is absent data wearing the costume of a measurement.
  assert.throws(() => dayKeyInTz("not a date", DEFAULT_TZ), /unparseable/);
  assert.throws(() => dayKeyInTz(new Date("x"), DEFAULT_TZ), /invalid Date/);
  checks += 2;
}

// --- dayBoundsInTz ----------------------------------------------------------
{
  const b = dayBoundsInTz("2026-08-08", DEFAULT_TZ);
  eq(b.startIso, "2026-08-07T18:30:00.000Z", "IST midnight is 18:30 UTC the previous day");
  eq(b.endMs - b.startMs, 86400000, "IST has no DST, so the day is exactly 24h");
  // Round trip: every instant inside the bounds maps back to the same day key.
  eq(dayKeyInTz(b.startMs, DEFAULT_TZ), "2026-08-08", "start is inside");
  eq(dayKeyInTz(b.endMs - 1, DEFAULT_TZ), "2026-08-08", "last ms is inside");
  eq(dayKeyInTz(b.endMs, DEFAULT_TZ), "2026-08-09", "end is exclusive");
  assert.throws(() => dayBoundsInTz("8 Aug 2026", DEFAULT_TZ), /YYYY-MM-DD/);
  checks += 1;
}

// A DST zone, because the two-pass offset solve exists for exactly this and
// Asia/Kolkata can never exercise it. 2026-03-29 is the UK spring-forward day.
{
  const short = dayBoundsInTz("2026-03-29", "Europe/London");
  eq(short.endMs - short.startMs, 23 * 3600000, "the spring-forward day is 23 hours long");
  const long = dayBoundsInTz("2026-10-25", "Europe/London");
  eq(long.endMs - long.startMs, 25 * 3600000, "the fall-back day is 25 hours long");
  for (const key of ["2026-03-29", "2026-10-25", "2026-06-15"]) {
    const b = dayBoundsInTz(key, "Europe/London");
    eq(dayKeyInTz(b.startMs, "Europe/London"), key, `round trip ${key}`);
    eq(dayKeyInTz(b.endMs - 1, "Europe/London"), key, `round trip end ${key}`);
  }
}

// --- instantAtLocal (the nudge scheduler's only clock) ----------------------
{
  const at = instantAtLocal("2026-08-08", 18 * 60 + 10, DEFAULT_TZ);
  eq(new Date(at).toISOString(), "2026-08-08T12:40:00.000Z", "18:10 IST is 12:40 UTC");
  eq(minuteOfDayInTz(at, DEFAULT_TZ), 18 * 60 + 10, "round trips through the zone");
}

// --- key arithmetic ---------------------------------------------------------
{
  eq(addDays("2026-08-08", 1), "2026-08-09", "next day");
  eq(addDays("2026-08-01", -1), "2026-07-31", "month boundary backwards");
  eq(addDays("2026-02-28", 1), "2026-03-01", "2026 is not a leap year");
  eq(addDays("2024-02-28", 1), "2024-02-29", "2024 is");
  eq(dayDiff("2026-07-11", "2026-08-01"), 21, "three weeks");
  eq(dayDiff("2026-08-01", "2026-07-11"), -21, "signed");
  // Crossing a DST boundary in the LOCAL zone must not shift a key, because key
  // arithmetic goes through UTC midnight where every day is 24h.
  eq(addDays("2026-03-28", 1), "2026-03-29", "no DST skip");
  eq(addDays("2026-10-24", 1), "2026-10-25", "no DST repeat");
}

// --- ISO weeks (the span floor counts these, not days) ----------------------
{
  eq(isoWeekKeyInTz("2026-08-01T12:00:00Z", DEFAULT_TZ), "2026-W31", "Sat 1 Aug 2026");
  eq(isoWeekKeyInTz("2026-08-02T12:00:00Z", DEFAULT_TZ), "2026-W31", "Sun 2 Aug closes the same ISO week");
  eq(isoWeekKeyInTz("2026-08-03T12:00:00Z", DEFAULT_TZ), "2026-W32", "Mon 3 Aug opens the next");
  // Year boundaries are where naive week numbering breaks. 1 Jan 2027 is a
  // Friday, so it belongs to ISO week 53 of 2026.
  eq(isoWeekKeyInTz("2027-01-01T12:00:00Z", DEFAULT_TZ), "2026-W53", "1 Jan 2027 is in ISO 2026-W53");
  eq(isoWeekKeyInTz("2026-01-01T12:00:00Z", DEFAULT_TZ), "2026-W01", "1 Jan 2026 is a Thursday, so W01");
  // And the tz matters here too: three pizza slices at 23:00 IST Saturday are one
  // week, but read in UTC they are the Saturday BEFORE and could land in W30.
  eq(isoWeekKeyInTz("2026-08-02T18:35:00Z", DEFAULT_TZ), "2026-W32", "00:05 IST Monday is the new week");
}

eq(hhmm(1090), "18:10", "hhmm");
eq(hhmm(0), "00:00", "hhmm midnight");
eq(hhmm(1440), "00:00", "hhmm wraps");

// ===========================================================================
// LINT: no NEW UTC-slice day keys anywhere in lib/ or src/
// ===========================================================================
//
// This is a freeze, not a clean-up: the modules below still use the old form and
// are owned by other work in flight. The budget stops the debt GROWING, and a
// line may opt out individually with a `tz-allowlist:` comment stating why.
// Every entry here is a real, currently-shipping day key that should eventually
// route through dayKeyInTz.
const ALLOWED = {
  // UTC-midnight key arithmetic inside tz.mjs itself - no zone is involved, the
  // input and output are both already local day keys.
  "lib/tz.mjs": 1,
  // Jarvis brief: builds a day key for the briefing row. Owned by the jarvis work.
  "lib/jarvis-brief.mjs": 1,
  // Statement pipeline: bank statement dates are DATE columns with no time, so
  // the instants involved are already UTC midnight and the slice is exact.
  "lib/statement-audit.mjs": 1,
  "lib/statement-link.mjs": 3,
  // Analytics + wellness surfaces: real IST-vs-UTC exposure, not owned here.
  "src/analytics/period-aggregator.js": 1,
  "src/domain/wellness/mood-triggers.js": 1,
  "src/domain/wellness/sleep-debt.js": 1,
  "src/domain/wellness/step-summary.js": 2,
  "src/domain/wellness/weekly-review.js": 1,
  "src/ui/dashboard-views.js": 1,
  // "today" for an export filename / an as-of date. Cosmetic, but still wrong
  // for 5.5 hours a day.
  "src/services/export-service.js": 1,
  "src/services/statement-import.js": 2,
};

const DAYKEY_RX = /toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const found = {};
const offenders = [];
for (const file of [...walk("lib"), ...walk("src")]) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = DAYKEY_RX.exec(line);
    if (!m) return;
    if (line.includes("tz-allowlist:")) return;          // explicit, reasoned opt-out
    const comment = line.indexOf("//");
    if (comment !== -1 && comment < m.index) return;      // prose about the bug, not the bug
    found[file] = (found[file] || 0) + 1;
    offenders.push(`${file}:${i + 1}`);
  });
}

for (const [file, n] of Object.entries(found)) {
  const budget = ALLOWED[file] || 0;
  assert.ok(
    n <= budget,
    `NEW UTC day key in ${file}: found ${n}, budget ${budget}.\n` +
    `  Use dayKeyInTz(instant, tz) from lib/tz.mjs. toISOString().slice(0,10) puts\n` +
    `  every instant after 18:30 UTC on the WRONG IST day, which turns a Friday-night\n` +
    `  habit into "every Friday" in a sentence the user reads.\n` +
    `  Offenders: ${offenders.filter((o) => o.startsWith(file)).join(", ")}`,
  );
  checks += 1;
}
// The budget must not rot either: a file that has been cleaned up should be
// removed from the list rather than left as a standing permission.
for (const [file, budget] of Object.entries(ALLOWED)) {
  assert.ok((found[file] || 0) <= budget, `${file} exceeded its budget`);
  checks += 1;
}

console.log(`tz tests passed (${checks} checks; UTC-day-key lint clean, ${Object.values(found).reduce((a, b) => a + b, 0)} legacy uses frozen under budget)`);
