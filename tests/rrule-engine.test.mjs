// RRULE CONFORMANCE - our hand-rolled engine against the reference implementation.
//
// lib/reminders.mjs is a recurrence engine we wrote ourselves. It has to be:
// it is copied byte-identically into supabase/functions/jarvis/index.ts where an
// import is impossible. That is a good reason to hand-roll it and no reason at
// all to TRUST it. Every other test in this repo checks our engine against dates
// a human typed out, which proves it agrees with whoever wrote the test.
//
// This one checks it against rrule.js - the most widely installed RFC 5545
// implementation in JavaScript, 2.6M npm downloads a week - over several
// thousand generated rules.
//
// WHO WINS A DISAGREEMENT: RFC 5545, not rrule.js. rrule is the interop
// reference, not the spec, and it has a defect of its own that this file
// measures (see LIBRARY DEFECTS below). So every fix made to lib/reminders.mjs
// off the back of this sweep cites the RFC clause that settles it, and the one
// case where rrule.js is the wrong one is worked around in lib/rrule-engine.mjs
// rather than copied.
//
// FOUR disagreements were found the first time this file ran, all ours:
//   1. a rule ruleProblem() rejects still produced dates    (RFC 3.3.10 phase)
//   2. the month walk gave up after six periods             (RFC 3.8.5.3 set)
//   3. COUNT stopped the series at 400                      (RFC 3.3.10 COUNT)
//   4. a quarterly step that does not divide the year       (RFC 3.3.10 BYMONTH)
// Each has a named regression case below, and each is a real reminder that would
// have fired on the wrong day or never fired at all.
//
// The DELIBERATE divergences are translated rather than hidden, and both are
// measured here so they can never be mistaken for agreement:
//   - the month-end CLAMP ("the 31st" is 28 Feb, because rolling a tax deadline
//     forward is the one direction that costs money) becomes
//     BYMONTHDAY=28,29,30,31;BYSETPOS=-1, ordinary RFC 5545 that rrule.js
//     expands to our twelve dates. The naive form is measured at seven. (What
//     actually goes in a .ics file is decided in tests/rrule-codec.test.mjs,
//     where ical.js expands that same string to 38.)
//   - our weeks start on SUNDAY, so weekly rules with an interval carry WKST=SU.
//     The RFC default is Monday and it changes real dates.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { RRule, rrulestr } from "../vendor/rrule/rrule@2.8.1/index.mjs";
import * as OURS from "../lib/reminders.mjs";
import * as REF from "../lib/rrule-engine.mjs";

// ---------------------------------------------------------------------------
// the vendored library is real, self-contained, and reachable by relative path
// ---------------------------------------------------------------------------
const VENDOR_ENTRY = "vendor/rrule/rrule@2.8.1/index.mjs";
const VENDOR_BUNDLE = "vendor/rrule/rrule@2.8.1/es2022/rrule.bundle.mjs";
assert.ok(existsSync(VENDOR_ENTRY), `missing vendored entry ${VENDOR_ENTRY}`);
assert.ok(existsSync(VENDOR_BUNDLE), `missing vendored bundle ${VENDOR_BUNDLE}`);
assert.equal(REF.RRULE_JS_VERSION, "2.8.1", "the wrapper and the vendored path must name the same version");
assert.equal(typeof RRule.optionsToString, "function", "the vendored entry is not the real rrule.js");

// No bare specifiers anywhere in the graph: a browser has no resolver, so one
// `import "tslib"` left in the bundle is a dead page. esm.sh's ?bundle build
// inlines the single dependency (tslib) for exactly this reason - the unbundled
// build imports "/tslib@^2.4.0?target=es2022", whose "?" cannot even be a
// filename on Windows.
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;
for (const file of [VENDOR_ENTRY, VENDOR_BUNDLE]) {
  const src = readFileSync(file, "utf8");
  for (const [, , spec] of src.matchAll(SPEC_RE)) {
    assert.ok(
      spec.startsWith("./") || spec.startsWith("../"),
      `${file} imports "${spec}" - a browser cannot resolve that`,
    );
    const target = posix.normalize(posix.join(posix.dirname(file), spec));
    assert.ok(existsSync(target), `${file} imports missing chunk ${target}`);
  }
  assert.ok(!/\bfrom\s*["']luxon["']/.test(src), "luxon must not be pulled in");
}

// ===========================================================================
// LIBRARY DEFECTS. The oracle is not infallible and this file says where.
// Both are re-measured here rather than cited, so the day rrule.js is fixed (or
// the workaround rots) this test says so instead of quietly passing.
// ===========================================================================

// rrule 2.8.1 SILENTLY DISCARDS `DTSTART;VALUE=DATE`. It substitutes the current
// wall clock and throws nothing. VALUE=DATE is what Google, Apple and our own
// exporter write for all-day events, so an imported birthday would re-anchor to
// the day of import - a wrong answer that looks like a right one, which is the
// exact failure class this codebase keeps rediscovering.
{
  const src = "DTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY;COUNT=3";
  const raw = rrulestr(src, { forceset: true }).all().map(REF.dateToKey);
  const today = REF.dateToKey(new Date(Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())));
  assert.equal(raw.length, 3);
  assert.notEqual(raw[0], "2026-01-31", "if this now passes, rrule.js fixed the bug - drop the workaround");
  assert.equal(raw[0], today, "and what it substitutes is literally today");

  // Our wrapper normalises date-valued properties to the UTC-midnight DATE-TIME
  // form rrulestr does read. Same instant, same meaning, correct answer.
  assert.deepEqual(REF.expandICalendar(src, "2026-01-01", "2026-12-31").dates,
    ["2026-01-31", "2026-03-31", "2026-05-31"]);

  // The same defect reaches EXDATE: a date-valued exclusion against a non-midnight
  // DTSTART matches nothing and is dropped without comment.
  const exSrc = "DTSTART:20260101T090000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEXDATE;VALUE=DATE:20260103";
  assert.equal(rrulestr(exSrc, { forceset: true }).all().length, 5, "the exclusion was ignored");
  assert.deepEqual(REF.expandICalendar(exSrc, "2026-01-01", "2026-12-31").dates,
    ["2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05"], "and honoured through the wrapper");
}

// ---------------------------------------------------------------------------
// THE CLAMP, measured. Our twelve dates against the RFC's seven.
// ---------------------------------------------------------------------------
{
  const rule = { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" };
  const ours = OURS.occurrencesBetween(rule, "2026-01-01", "2026-12-31", 40);
  assert.equal(ours.length, 12);
  assert.equal(ours[1], "2026-02-28");
  assert.deepEqual(REF.occurrencesBetween(rule, "2026-01-01", "2026-12-31", 40), ours,
    "rrule.js expands our clamp set to the same twelve dates");

  const naive = new RRule({ freq: RRule.MONTHLY, dtstart: REF.keyToDate("2026-01-31"), bymonthday: [31] });
  const naiveDates = naive.between(REF.keyToDate("2026-01-01"), REF.keyToDate("2026-12-31"), true).map(REF.dateToKey);
  assert.equal(naiveDates.length, 7, "plain BYMONTHDAY=31 only fires in the 31-day months");
  assert.ok(!naiveDates.includes("2026-02-28"), "and the February deadline is simply gone");
}

// ---------------------------------------------------------------------------
// SUNDAY WEEKS, measured. Not a preference - it moves dates.
// ---------------------------------------------------------------------------
{
  const rule = { freq: "weekly", weekdays: [0, 3], interval: 2, dtstart: "2026-08-02" };
  const ours = OURS.occurrencesBetween(rule, "2026-08-01", "2026-10-01", 40);
  assert.deepEqual(ours.slice(0, 4), ["2026-08-02", "2026-08-05", "2026-08-16", "2026-08-19"]);
  assert.deepEqual(REF.occurrencesBetween(rule, "2026-08-01", "2026-10-01", 40), ours);
  assert.match(REF.ruleToRRule(rule, { since: "2026-08-01" }).rrule, /WKST=SU/);

  const mondayWeeks = new RRule({
    freq: RRule.WEEKLY, interval: 2, wkst: RRule.MO, dtstart: REF.keyToDate("2026-08-02"),
    byweekday: [RRule.SU, RRule.WE],
  }).between(REF.keyToDate("2026-08-01"), REF.keyToDate("2026-10-01"), true).map(REF.dateToKey);
  assert.equal(ours.length, 10);
  assert.equal(mondayWeeks.length, 9, "the RFC default puts the Wednesday in the off week");
  assert.notEqual(mondayWeeks[1], ours[1], "they part company at the second date");
}

// ===========================================================================
// THE SWEEP. Every frequency, intervals 1-12, every weekday and multi-weekday
// set, nth-weekday including -1 and +/-5, days 29/30/31, UNTIL, COUNT, EXDATE,
// RDATE, leap years, month boundaries, year boundaries - through both engines.
// ===========================================================================

const WINDOWS = [
  ["2026-01-01", "2027-12-31"],
  ["2027-11-15", "2028-04-15"], // a year boundary running into a leap February
  ["2028-01-01", "2028-12-31"], // a leap year
  ["2030-06-01", "2033-06-01"], // long, and far from every anchor above
];
// Anchors chosen to sit on the edges: a 31st, a 28 Feb, a 29 Feb, a 31 Dec, a
// 30 Nov, a 1 March (the day after February), plus none at all.
const DTSTARTS = [null, "2026-01-31", "2026-02-28", "2026-08-05", "2026-08-03",
  "2026-12-31", "2028-02-29", "2027-05-20", "2026-11-30", "2026-03-01"];
const WEEKDAY_SETS = [[0], [1], [3], [6], [1, 3, 5], [0, 3], [0, 6], [5, 6],
  [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6]];
const DOMS = [1, 5, 10, 14, 28, 29, 30, 31];
const MONTHS = [1, 2, 4, 5, 8, 11, 12];
const NTHS = [1, 2, 3, 4, 5, -1, -2, -5];

const rules = [];
const push = (r) => rules.push(r);

for (const d of ["2026-09-12", "2028-02-29", "2026-12-31", "2020-01-01"]) push({ freq: "once", on_date: d });
for (let iv = 1; iv <= 12; iv++) for (const ds of DTSTARTS) push({ freq: "daily", interval: iv, dtstart: ds });
for (let iv = 1; iv <= 12; iv++) for (const wds of WEEKDAY_SETS) for (const ds of DTSTARTS) {
  push({ freq: "weekly", weekdays: wds, interval: iv, dtstart: ds });
}
for (let iv = 1; iv <= 12; iv++) for (const dom of DOMS) for (const ds of DTSTARTS) {
  push({ freq: "monthly", day_of_month: dom, interval: iv, dtstart: ds });
}
for (const iv of [1, 2, 3, 12]) for (const nth of NTHS) for (const wd of [0, 2, 5, 6]) for (const ds of DTSTARTS) {
  push({ freq: "monthly", nth_weekday: nth, weekday: wd, interval: iv, dtstart: ds });
}
for (const iv of [1, 2, 3, 4, 5, 6]) for (const mo of MONTHS) for (const dom of DOMS) {
  for (const ds of [null, "2026-01-10", "2027-05-20", "2028-02-29"]) {
    push({ freq: "quarterly", month_of_year: mo, day_of_month: dom, interval: iv, dtstart: ds });
  }
}
for (const iv of [1, 2]) for (const mo of MONTHS) for (const nth of NTHS) for (const wd of [1, 4]) {
  push({ freq: "quarterly", month_of_year: mo, nth_weekday: nth, weekday: wd, interval: iv, dtstart: "2026-01-10" });
}
for (const iv of [1, 2, 3, 5, 12]) for (const mo of MONTHS) for (const dom of DOMS) {
  for (const ds of [null, "2026-08-14", "2028-02-29"]) {
    push({ freq: "yearly", month_of_year: mo, day_of_month: dom, interval: iv, dtstart: ds });
  }
}
for (const iv of [1, 2]) for (const mo of MONTHS) for (const nth of NTHS) for (const wd of [0, 3, 6]) {
  push({ freq: "yearly", month_of_year: mo, nth_weekday: nth, weekday: wd, interval: iv, dtstart: "2026-01-15" });
}

// Limits and explicit dates, layered on one rule of every shape. COUNT reaches
// past 400 on purpose: that used to be the point where the series stopped.
const CORE = [
  { freq: "daily", interval: 2, dtstart: "2026-08-05" },
  { freq: "weekly", weekdays: [1, 3, 5], dtstart: "2026-08-03" },
  { freq: "weekly", weekdays: [0, 3], interval: 2, dtstart: "2026-08-02" },
  { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" },
  { freq: "monthly", nth_weekday: -1, weekday: 5, dtstart: "2026-01-30" },
  { freq: "quarterly", month_of_year: 1, day_of_month: 10, dtstart: "2026-01-10" },
  { freq: "yearly", month_of_year: 2, day_of_month: 29, dtstart: "2026-02-28" },
];
for (const c of CORE) {
  for (const n of [1, 2, 3, 6, 12, 40, 399, 400, 401, 500]) push({ ...c, count: n });
  for (const u of ["2026-02-28", "2026-12-31", "2027-06-15", "2028-02-29"]) push({ ...c, until: u });
  push({ ...c, count: 5, until: "2026-09-30" });
  push({ ...c, count: 40, until: "2033-01-01" });
  push({ ...c, max_count: 4 });                       // the DB spelling of count
  push({ ...c, rule_interval: 3 });                   // and of interval
  push({ ...c, exdates: ["2026-08-05", "2026-09-01", "2026-01-31"] });
  push({ ...c, rdates: ["2026-09-15", "2027-03-02"] });
  push({ ...c, exdates: ["2026-09-15"], rdates: ["2026-09-15", "2026-10-02"] });
  push({ ...c, count: 4, exdates: ["2026-09-01", "2026-04-30"] });
}

let compared = 0, refused = 0, occurrences = 0;
const failures = [];
for (const rule of rules) {
  const problem = OURS.ruleProblem(rule);
  if (problem) {
    // A rule the validator rejects must produce NOTHING. A validator the engine
    // disagrees with is worse than no validator: it tells the user the rule is
    // broken while the server quietly fires it on dates nobody chose.
    for (const [from, to] of WINDOWS) {
      const fired = OURS.occurrencesBetween(rule, from, to, 1200);
      if (fired.length) {
        failures.push(`ruleProblem says "${problem}" but the engine fired ${fired.slice(0, 3).join(", ")} for ${JSON.stringify(rule)}`);
      }
      assert.equal(REF.occurrencesBetween(rule, from, to, 1200).length, 0);
    }
    refused++;
    continue;
  }
  const built = REF.ruleToRRule(rule, { since: WINDOWS[0][0] });
  assert.ok(!built.error, `rrule.js could not express ${JSON.stringify(rule)}: ${built.error}`);
  for (const [from, to] of WINDOWS) {
    compared++;
    const ours = OURS.occurrencesBetween(rule, from, to, 1200);
    const theirs = REF.occurrencesBetween(rule, from, to, 1200);
    occurrences += ours.length;
    if (ours.join(",") !== theirs.join(",")) {
      failures.push([
        `sequences differ for ${JSON.stringify(rule)} in [${from}, ${to}]`,
        `  DTSTART ${built.dtstart}  RRULE ${built.rrule || "(none)"}`,
        `  ours : ${ours.slice(0, 12).join(" ")} (${ours.length})`,
        `  rrule: ${theirs.slice(0, 12).join(" ")} (${theirs.length})`,
      ].join("\n"));
    }
  }
}

// The unwindowed question is the sharper one: "when is the next occurrence,
// however far away" has no `to` to hide a missing date behind, which is how the
// nth-weekday search-budget bug stayed invisible for so long.
const FROMS = ["2026-01-01", "2026-02-28", "2026-08-05", "2026-12-31", "2027-03-01",
  "2028-02-29", "2029-11-15", "2035-07-04", "2044-01-01"];
let nextCompared = 0;
for (const rule of rules) {
  if (OURS.ruleProblem(rule)) continue;
  for (const from of FROMS) {
    nextCompared++;
    const a = OURS.nextOccurrence(rule, from);
    const b = REF.nextOccurrence(rule, from);
    if (a !== b) {
      failures.push(`nextOccurrence from ${from} for ${JSON.stringify(rule)}: ours ${a}, rrule.js ${b}`);
    }
  }
}

assert.deepEqual(failures.slice(0, 8), [], `${failures.length} conformance failure(s):\n${failures.slice(0, 8).join("\n")}`);
assert.ok(compared > 3000, `the sweep must actually sweep: only ${compared} window comparisons`);
assert.ok(occurrences > 50000, `the sweep must generate real dates: only ${occurrences}`);

// ===========================================================================
// REGRESSIONS. One case per divergence this sweep found, so a fix that gets
// reverted fails on a named date instead of somewhere in the noise.
// ===========================================================================

// 1. REFUSED BUT FIRED. ruleProblem() rejects an every-N rule with no anchor
//    ("every-N rules need a start date to count from") and the monthly walk
//    fired it anyway, phasing off whatever month the CALLER asked from - so the
//    same stored rule answered Jan/Mar/May in January and Jun/Aug/Oct in June.
{
  const rule = { freq: "monthly", day_of_month: 1, interval: 2 };
  assert.match(OURS.ruleProblem(rule), /start date/);
  assert.equal(OURS.nextOccurrence(rule, "2026-01-01"), null);
  assert.deepEqual(OURS.occurrencesBetween(rule, "2026-01-01", "2026-12-31", 20), []);
  assert.deepEqual(OURS.occurrencesBetween(rule, "2030-06-01", "2030-12-31", 20), []);
  // The same gate now covers every reason ruleProblem gives, not just this one.
  assert.equal(OURS.nextOccurrence({ freq: "daily", until: "next year" }, "2026-01-01"), null,
    "an unparseable UNTIL used to be ignored, and the series ran forever");
  assert.equal(OURS.nextOccurrence({ freq: "daily", dtstart: "soon" }, "2026-01-01"), null,
    "a broken dtstart used to read as 'no anchor' rather than as a broken rule");
}

// 2. THE SEARCH BUDGET. The month walk stepped one month at a time and gave up
//    after step*6+24 months, which is six periods for a yearly rule. "The 5th
//    Tuesday of February" needs a leap February that starts on a Tuesday - 2028,
//    then 2056 - so from 2029 the engine returned null forever. 58 distinct
//    nth-weekday rules were wrong this way.
{
  const rule = { freq: "yearly", month_of_year: 2, nth_weekday: 5, weekday: 2, dtstart: "2026-01-15" };
  assert.equal(OURS.nextOccurrence(rule, "2026-01-01"), "2028-02-29");
  assert.equal(OURS.nextOccurrence(rule, "2029-11-15"), "2056-02-29", "twenty-seven years out, and real");
  assert.equal(REF.nextOccurrence(rule, "2029-11-15"), "2056-02-29");

  const monthly = { freq: "monthly", month_of_year: 2, nth_weekday: 5, weekday: 0, interval: 3, dtstart: "2026-01-15" };
  assert.equal(OURS.nextOccurrence(monthly, "2028-02-29"), REF.nextOccurrence(monthly, "2028-02-29"));
  assert.equal(OURS.nextOccurrence(monthly, "2028-02-29"), "2031-08-31");

  // A rule that genuinely never fires still has to stop, not hang.
  assert.equal(OURS.nextOccurrence({ freq: "yearly", month_of_year: 2, day_of_month: 30, dtstart: "2026-01-01" }, "2026-01-01"),
    "2026-02-28", "day 30 of February is the clamp, not an impossibility");
}

// 3. THE COUNT CAP. withinCount() enumerated at most 400 occurrences, so
//    occurrence 401 of a count-500 rule read as "past the count" and the series
//    stopped dead. reminders.max_count is checked 1..400 in the DB but
//    lib/schedule-args.mjs clamps a scheduled task's count to 500.
{
  const rule = { freq: "daily", interval: 1, dtstart: "2026-01-01", count: 500 };
  assert.equal(OURS.nextOccurrence(rule, "2027-03-01"), "2027-03-01");
  assert.equal(REF.nextOccurrence(rule, "2027-03-01"), "2027-03-01");
  assert.equal(OURS.nextOccurrence(rule, "2027-05-15"), "2027-05-15", "the 500th and last");
  assert.equal(OURS.nextOccurrence(rule, "2027-05-16"), null, "and nothing after it");
}

// 4. THE ROTATING QUARTER. Not a date bug in the engine - a bug in what left it.
//    Every quarterly rule used to export as FREQ=YEARLY;BYMONTH=..., which is
//    only true while the step divides the year. See tests/rrule-codec.test.mjs
//    for the export; here is the engine's own answer, which was always right.
{
  const rule = { freq: "quarterly", month_of_year: 1, day_of_month: 10, interval: 3, dtstart: "2026-01-10" };
  const ours = OURS.occurrencesBetween(rule, "2026-01-01", "2030-12-31", 40);
  assert.deepEqual(ours, ["2026-01-10", "2026-10-10", "2027-07-10", "2028-04-10", "2029-01-10", "2029-10-10", "2030-07-10"]);
  assert.deepEqual(REF.occurrencesBetween(rule, "2026-01-01", "2030-12-31", 40), ours);
  assert.equal(REF.ruleToRRule(rule, { since: "2026-01-01" }).rrule, "FREQ=MONTHLY;INTERVAL=9;BYMONTHDAY=10");
}

// ---------------------------------------------------------------------------
// the rules that are actually in the owner's database
// ---------------------------------------------------------------------------
{
  const gst = { freq: "quarterly", month_of_year: 1, day_of_month: 10, lead_days: 7 };
  assert.deepEqual(
    REF.occurrencesBetween(gst, "2026-01-01", "2027-12-31", 40),
    OURS.occurrencesBetween(gst, "2026-01-01", "2027-12-31", 40),
  );
  assert.equal(REF.ruleToRRule(gst, { since: "2026-01-01" }).rrule, "FREQ=YEARLY;BYMONTH=1,4,7,10;BYMONTHDAY=10");

  const bday = { freq: "yearly", month_of_year: 8, day_of_month: 14 };
  assert.equal(REF.nextOccurrence(bday, "2026-08-14"), "2026-08-14", "due ON the day, not next year");
  assert.equal(REF.nextOccurrence(bday, "2026-08-15"), "2027-08-14");
  assert.equal(REF.ruleToRRule(bday, { since: "2026-01-01" }).rrule, "FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=14");
}

// ---------------------------------------------------------------------------
// THE TIMEZONE TRAP. rrule.js returns Date objects whose UTC fields carry the
// intended wall clock ("UTC-but-not-UTC", rrule issue #336, open since 2019), so
// the obvious `.toISOString()` is wrong by the host offset - 5.5 hours in this
// app's zone, and INVISIBLE in a CI box running UTC. lib/rrule-engine.mjs only
// ever reads getUTC* fields, which is correct in any zone; this proves it by
// running the same rules in four of them rather than by asserting the intent.
//
// The child process is the only honest way to do this: Node reads TZ once at
// startup, so setting process.env.TZ inside a running test proves nothing.
{
  const PROBE = `
    (async () => {
      const OURS = await import(${JSON.stringify(new URL("../lib/reminders.mjs", import.meta.url).href)});
      const REF = await import(${JSON.stringify(new URL("../lib/rrule-engine.mjs", import.meta.url).href)});
      const rules = [
        { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" },
        { freq: "weekly", weekdays: [0, 3], interval: 2, dtstart: "2026-08-02" },
        { freq: "yearly", month_of_year: 2, day_of_month: 29, dtstart: "2026-02-28" },
        { freq: "monthly", nth_weekday: -1, weekday: 5, dtstart: "2026-01-30" },
        { freq: "daily", interval: 3, dtstart: "2026-12-30" },
      ];
      const out = [];
      for (const r of rules) {
        out.push(OURS.occurrencesBetween(r, "2026-01-01", "2027-12-31", 300).join(" "));
        out.push(REF.occurrencesBetween(r, "2026-01-01", "2027-12-31", 300).join(" "));
        out.push(String(REF.ruleToRRule(r, { since: "2026-01-01" }).dtstart));
      }
      console.log(out.join("|"));
    })();
  `;
  const answers = new Map();
  // Kiritimati is UTC+14 and St John's is UTC-3:30 - both sides of the date line
  // from UTC, and one of them on a half-hour offset like ours.
  for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati", "America/St_Johns"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE],
      { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim();
    answers.set(tz, out);
  }
  const [[baseTz, base]] = [...answers];
  for (const [tz, got] of answers) {
    assert.equal(got, base, `the engines answer differently under TZ=${tz} than under TZ=${baseTz} - a local-time read got in`);
  }
  assert.ok(base.includes("2026-02-28"), "the probe must actually have produced dates");
}

console.log(`rrule-engine tests passed: ${rules.length} generated rules, ${compared} windowed sequence comparisons `
  + `(${occurrences} occurrences) + ${nextCompared} next-occurrence comparisons agree with rrule.js@${REF.RRULE_JS_VERSION}; `
  + `${refused} rules refused by both`);
