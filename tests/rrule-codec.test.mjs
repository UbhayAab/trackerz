// RRULE CODEC - the clamp-vs-RFC-5545 round trip.
//
// The bug this file exists to prevent has never happened yet, which is the whole
// point of writing it before the export button ships: lib/reminders.mjs CLAMPS
// "the 31st" to 28 Feb (rolling a tax deadline forward is the one direction that
// costs money), and RFC 5545 BYMONTHDAY=31 SKIPS February. Exported naively,
// "the 31st of every month" is 11 fires a year in Google against our 12, and the
// one it drops is a deadline nobody is told about.
//
// The round trip below is checked against expandRRuleSpec(), an expander written
// from the RFC rather than from our engine - so a pass means the standard and
// our clamp agree on the dates, not that our code agrees with itself.
import assert from "node:assert/strict";
import { occurrencesBetween, nextOccurrence, describeRule } from "../lib/reminders.mjs";
import {
  toRRule, toICS, fallbackRDate, parseICalendar, expandRRuleSpec, parseRRule, needsClampDialect,
} from "../lib/rrule-codec.mjs";

// Expand what toRRule() produced, using the independent RFC expander.
// `since` is pinned to the window start so a rule with no dtstart of its own
// exports deterministically - otherwise the derived DTSTART would be "the next
// occurrence from the wall clock" and this test would change answers by the day.
function roundTrip(rule, from, to) {
  const out = toRRule(rule, { since: from });
  assert.ok(!out.error, `toRRule failed: ${out.error}`);
  const { spec, warnings } = parseICalendar(out.lines.join("\r\n"));
  assert.deepEqual(warnings, [], "the codec must not emit anything its own parser cannot read");
  return { rrule: out.rrule, dates: expandRRuleSpec(spec, from, to), out };
}

// ---------------------------------------------------------------------------
// THE DIVERGENCE. "the 31st of every month" across a full year.
// ---------------------------------------------------------------------------
{
  const rule = { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31", title: "Rent" };
  const ours = occurrencesBetween(rule, "2026-01-01", "2026-12-31", 40);
  assert.equal(ours.length, 12, "our engine fires every month");
  assert.equal(ours[1], "2026-02-28", "clamped into February, not skipped and not rolled to 3 March");

  const rt = roundTrip(rule, "2026-01-01", "2026-12-31");
  assert.match(rt.rrule, /BYMONTHDAY=28,29,30,31/);
  assert.match(rt.rrule, /BYSETPOS=-1/);
  assert.deepEqual(rt.dates, ours, "the exported rule must produce OUR twelve dates, not eleven");

  // And the naive export, to prove the divergence is real rather than theoretical.
  const naive = parseICalendar("DTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31");
  const naiveDates = expandRRuleSpec(naive.spec, "2026-01-01", "2026-12-31");
  assert.equal(naiveDates.length, 7, "plain BYMONTHDAY=31 only fires in the 31-day months");
  assert.ok(!naiveDates.includes("2026-02-28"), "and February is simply gone");
}

// A leap year, where the clamp target itself moves.
{
  const rule = { freq: "monthly", day_of_month: 31, dtstart: "2028-01-31" };
  const ours = occurrencesBetween(rule, "2028-01-01", "2028-12-31", 40);
  assert.equal(ours[1], "2028-02-29", "2028 is a leap year");
  assert.deepEqual(roundTrip(rule, "2028-01-01", "2028-12-31").dates, ours);
}

// Days 29 and 30 emit the shorter clamp set and still round-trip.
for (const day of [29, 30]) {
  const rule = { freq: "monthly", day_of_month: day, dtstart: `2026-01-${day}` };
  const ours = occurrencesBetween(rule, "2026-01-01", "2026-12-31", 40);
  assert.equal(ours.length, 12);
  const rt = roundTrip(rule, "2026-01-01", "2026-12-31");
  assert.deepEqual(rt.dates, ours, `day ${day} must round-trip`);
}

// Day 28 and below has no divergence and must NOT get a BYSETPOS it does not need.
{
  const rt = roundTrip({ freq: "monthly", day_of_month: 5, dtstart: "2026-01-05" }, "2026-01-01", "2026-12-31");
  assert.equal(rt.rrule, "FREQ=MONTHLY;BYMONTHDAY=5");
  assert.equal(rt.dates.length, 12);
}

// ---------------------------------------------------------------------------
// the real rules in the owner's database
// ---------------------------------------------------------------------------
{
  // GST: the 10th of Jan/Apr/Jul/Oct.
  const gst = { freq: "quarterly", month_of_year: 1, day_of_month: 10, lead_days: 7 };
  const ours = occurrencesBetween(gst, "2026-01-01", "2027-12-31", 40);
  assert.deepEqual(ours, [
    "2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10",
    "2027-01-10", "2027-04-10", "2027-07-10", "2027-10-10",
  ]);
  const rt = roundTrip(gst, "2026-01-01", "2027-12-31");
  assert.match(rt.rrule, /FREQ=YEARLY;BYMONTH=1,4,7,10;BYMONTHDAY=10/);
  assert.deepEqual(rt.dates, ours, "the four filing dates, every year");
}
{
  // Birthday: 14 August, forever.
  const bday = { freq: "yearly", month_of_year: 8, day_of_month: 14 };
  const ours = occurrencesBetween(bday, "2026-01-01", "2030-12-31", 40);
  const rt = roundTrip(bday, "2026-01-01", "2030-12-31");
  assert.equal(rt.rrule, "FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=14");
  assert.deepEqual(rt.dates, ours);
}
{
  // A 29 February birthday: BYMONTH restricts the year's set to February, so
  // BYSETPOS=-1 picks 29 in a leap year and 28 otherwise - our clamp exactly.
  const leap = { freq: "yearly", month_of_year: 2, day_of_month: 29, dtstart: "2026-02-28" };
  const ours = occurrencesBetween(leap, "2026-01-01", "2029-12-31", 10);
  assert.deepEqual(ours, ["2026-02-28", "2027-02-28", "2028-02-29", "2029-02-28"]);
  assert.deepEqual(roundTrip(leap, "2026-01-01", "2029-12-31").dates, ours);
}

// ---------------------------------------------------------------------------
// the new modifiers
// ---------------------------------------------------------------------------
{
  // Every other Wednesday.
  //
  // WKST=SU is new (2026-08-06) and is not cosmetic. lib/reminders.mjs counts
  // weeks from SUNDAY; RFC 5545's default is Monday, and for an INTERVAL>1
  // weekly rule that decides which week is the "off" week. Measured through
  // rrule.js on "every other Sunday and Wednesday" from a Sunday start: 10 dates
  // our way, 9 the RFC-default way, disagreeing from the second date on. The old
  // expectation without WKST happened to be safe for THIS rule - one weekday,
  // equal to DTSTART's - and silently wrong for the general case, so the export
  // now always states which day the week starts on.
  const rule = { freq: "weekly", weekday: 3, interval: 2, dtstart: "2026-08-05" };
  const ours = occurrencesBetween(rule, "2026-08-01", "2026-10-31", 20);
  const rt = roundTrip(rule, "2026-08-01", "2026-10-31");
  assert.equal(rt.rrule, "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=WE");
  assert.deepEqual(rt.dates, ours);

  // The rule that made WKST load-bearing, both readings spelled out.
  const straddle = { freq: "weekly", weekdays: [0, 3], interval: 2, dtstart: "2026-08-02" };
  const straddleOurs = occurrencesBetween(straddle, "2026-08-01", "2026-10-01", 20);
  assert.deepEqual(straddleOurs.slice(0, 4), ["2026-08-02", "2026-08-05", "2026-08-16", "2026-08-19"]);
  assert.deepEqual(roundTrip(straddle, "2026-08-01", "2026-10-01").dates, straddleOurs);
  const mondayWeeks = parseICalendar("DTSTART;VALUE=DATE:20260802\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=SU,WE");
  assert.notDeepEqual(
    expandRRuleSpec(mondayWeeks.spec, "2026-08-01", "2026-10-01"), straddleOurs,
    "if Monday-weeks and Sunday-weeks agreed here, WKST would not be worth emitting",
  );
}
{
  // Mon/Wed/Fri.
  const rule = { freq: "weekly", weekdays: [1, 3, 5], dtstart: "2026-08-03" };
  const ours = occurrencesBetween(rule, "2026-08-01", "2026-08-31", 40);
  const rt = roundTrip(rule, "2026-08-01", "2026-08-31");
  assert.equal(rt.rrule, "FREQ=WEEKLY;BYDAY=MO,WE,FR");
  assert.deepEqual(rt.dates, ours);
}
{
  // The 3rd Tuesday, and the last Friday.
  // "+3TU" rather than "3TU" because rrule.js writes the RRULE now and that is
  // the form it emits. RFC 5545's weekdaynum takes an optional sign, so both
  // spellings are the same rule; the old expectation was our hand-rolled
  // spelling, not the reference implementation's.
  const third = { freq: "monthly", nth_weekday: 3, weekday: 2, dtstart: "2026-08-18" };
  const rt = roundTrip(third, "2026-08-01", "2026-12-31");
  assert.equal(rt.rrule, "FREQ=MONTHLY;BYDAY=+3TU");
  assert.deepEqual(rt.dates, occurrencesBetween(third, "2026-08-01", "2026-12-31", 20));

  const last = { freq: "monthly", nth_weekday: -1, weekday: 5, dtstart: "2026-08-28" };
  const rt2 = roundTrip(last, "2026-08-01", "2026-12-31");
  assert.equal(rt2.rrule, "FREQ=MONTHLY;BYDAY=-1FR");
  assert.deepEqual(rt2.dates, occurrencesBetween(last, "2026-08-01", "2026-12-31", 20));
}
{
  // UNTIL, COUNT, EXDATE, RDATE.
  const until = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", until: "2026-11-01" };
  assert.deepEqual(roundTrip(until, "2026-01-01", "2027-12-31").dates,
    occurrencesBetween(until, "2026-01-01", "2027-12-31", 40));

  const count = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", count: 3 };
  const rtc = roundTrip(count, "2026-01-01", "2027-12-31");
  assert.match(rtc.rrule, /COUNT=3/);
  assert.deepEqual(rtc.dates, ["2026-08-01", "2026-09-01", "2026-10-01"]);
  assert.deepEqual(rtc.dates, occurrencesBetween(count, "2026-01-01", "2027-12-31", 40));

  const ex = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", exdates: ["2026-10-01"], rdates: ["2026-09-15"] };
  const rte = roundTrip(ex, "2026-08-01", "2026-12-31");
  assert.ok(rte.out.lines.some((l) => l.startsWith("EXDATE")), "EXDATE is emitted");
  assert.ok(rte.out.lines.some((l) => l.startsWith("RDATE")), "RDATE is emitted");
  assert.deepEqual(rte.dates, occurrencesBetween(ex, "2026-08-01", "2026-12-31", 40));
  assert.ok(!rte.dates.includes("2026-10-01"), "the excluded date is gone from both");
  assert.ok(rte.dates.includes("2026-09-15"), "and the extra date is in both");
}

// ---------------------------------------------------------------------------
// 2026-08-06: the two bugs the hand-rolled serialiser shipped with, found the
// moment rrule.js was asked the same question.
// ---------------------------------------------------------------------------
{
  // "Every 9 months" (quarterly, interval 3). The old codec put every quarterly
  // rule in FREQ=YEARLY;BYMONTH=..., which can only be right while the step
  // divides the year. From January, every 9 months is Jan, Oct, Jul, Apr, Jan -
  // it ROTATES - and BYMONTH=1,10 freezes it at Jan/Oct forever.
  const rule = { freq: "quarterly", month_of_year: 1, day_of_month: 10, interval: 3, dtstart: "2026-01-10" };
  const ours = occurrencesBetween(rule, "2026-01-01", "2030-12-31", 40);
  assert.deepEqual(ours, ["2026-01-10", "2026-10-10", "2027-07-10", "2028-04-10", "2029-01-10", "2029-10-10", "2030-07-10"]);
  const rt = roundTrip(rule, "2026-01-01", "2030-12-31");
  assert.equal(rt.rrule, "FREQ=MONTHLY;INTERVAL=9;BYMONTHDAY=10", "a step that does not divide the year cannot be a BYMONTH list");
  assert.deepEqual(rt.dates, ours);

  const frozen = parseICalendar("DTSTART;VALUE=DATE:20260110\r\nRRULE:FREQ=YEARLY;BYMONTH=1,10;BYMONTHDAY=10");
  assert.deepEqual(
    expandRRuleSpec(frozen.spec, "2026-01-01", "2030-12-31"),
    ["2026-01-10", "2026-10-10", "2027-01-10", "2027-10-10", "2028-01-10", "2028-10-10",
      "2029-01-10", "2029-10-10", "2030-01-10", "2030-10-10"],
    "the old export: ten dates, only the first two of which are the rule's",
  );

  // Steps that DO divide the year keep the phase inside the rule, where a
  // calendar rewriting DTSTART cannot move it.
  assert.match(roundTrip({ ...rule, interval: 2 }, "2026-01-01", "2030-12-31").rrule, /^FREQ=YEARLY;BYMONTH=1,7;/);
  assert.match(roundTrip({ ...rule, interval: 4 }, "2026-01-01", "2030-12-31").rrule, /^FREQ=YEARLY;BYMONTH=1;/);
}
{
  // UNTIL has to carry DTSTART's value type (RFC 5545 3.3.10). We export DTSTART
  // as a DATE, so a DATE-TIME UNTIL - which is all rrule.js writes - is a
  // mismatched pair that stricter calendars reject outright.
  const rule = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", until: "2026-11-01" };
  const rt = roundTrip(rule, "2026-01-01", "2027-12-31");
  assert.match(rt.rrule, /UNTIL=20261101$/);
  assert.ok(!/UNTIL=\d{8}T/.test(rt.rrule), "a DATE dtstart may not be paired with a DATE-TIME until");
  assert.deepEqual(rt.dates, occurrencesBetween(rule, "2026-01-01", "2027-12-31", 40));
}
{
  // COUNT and UNTIL MUST NOT both appear in one RECUR, but our rule shape allows
  // both and the engine intersects them. Export whichever ends the series first,
  // which reproduces the intersection exactly instead of dropping a limit.
  const short = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", count: 12, until: "2026-10-01" };
  const rtShort = roundTrip(short, "2026-01-01", "2028-12-31");
  assert.match(rtShort.rrule, /UNTIL=20261001/);
  assert.ok(!/COUNT=/.test(rtShort.rrule));
  assert.deepEqual(rtShort.dates, occurrencesBetween(short, "2026-01-01", "2028-12-31", 40));

  const capped = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", count: 2, until: "2027-10-01" };
  const rtCapped = roundTrip(capped, "2026-01-01", "2028-12-31");
  assert.match(rtCapped.rrule, /COUNT=2/);
  assert.deepEqual(rtCapped.dates, occurrencesBetween(capped, "2026-01-01", "2028-12-31", 40));
}

{
  // THE DATABASE SPELLINGS. `interval` is a Postgres type name and `count` is an
  // aggregate, so the columns are rule_interval / max_count (20260806000030).
  // lib/reminders.mjs has always read both; the hand-rolled serialiser here read
  // only `rule.count` and `rule.interval`, so a row handed straight from
  // PostgREST exported as a series with NO INTERVAL and NO END - the reminder
  // recurs forever in the user's real calendar and monthly instead of bimonthly.
  // Going through rrule-engine's ruleCount/ruleInterval is what fixed it; this
  // holds the fix by asserting the exported dates ARE the engine's dates.
  const dbRow = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", rule_interval: 2, max_count: 3 };
  const rt = roundTrip(dbRow, "2026-01-01", "2028-12-31");
  assert.equal(rt.rrule, "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1;COUNT=3");
  assert.deepEqual(rt.dates, ["2026-08-01", "2026-10-01", "2026-12-01"]);
  assert.deepEqual(rt.dates, occurrencesBetween(dbRow, "2026-01-01", "2028-12-31", 40));

  // The JSON spellings still work and must mean the same thing.
  const jsonRow = { freq: "monthly", day_of_month: 1, dtstart: "2026-08-01", interval: 2, count: 3 };
  assert.equal(toRRule(jsonRow, { since: "2026-01-01" }).rrule, rt.rrule);

  // And a weekly row with the DB's nulls is refused rather than exported as a
  // Sunday series nobody asked for.
  assert.match(toRRule({ freq: "weekly", weekday: null, weekdays: null, dtstart: "2026-08-01" }).error || "",
    /at least one weekday/);
}

// ---------------------------------------------------------------------------
// the safe fallback: an explicit date list nothing can misread
// ---------------------------------------------------------------------------
{
  const rule = { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" };
  const fb = fallbackRDate(rule, { from: "2026-01-01", years: 1 });
  assert.ok(!fb.error);
  assert.deepEqual(fb.rdate.slice(0, 12), occurrencesBetween(rule, "2026-01-01", "2026-12-31", 12));
  const { spec } = parseICalendar(fb.lines.join("\r\n"));
  assert.deepEqual(
    expandRRuleSpec(spec, "2026-01-01", "2026-12-31"),
    occurrencesBetween(rule, "2026-01-01", "2026-12-31", 12),
    "the RDATE-only export is the same twelve dates",
  );
}

// A whole .ics, and the time-of-day note that keeps a timed reminder honest.
{
  const ics = toICS({ freq: "quarterly", month_of_year: 1, day_of_month: 10, at_time: "09:30" }, { title: "File quarterly GST" });
  assert.ok(!ics.error);
  assert.match(ics.ics, /BEGIN:VCALENDAR/);
  assert.match(ics.ics, /RRULE:FREQ=YEARLY;BYMONTH=1,4,7,10;BYMONTHDAY=10/);
  assert.match(ics.ics, /SUMMARY:File quarterly GST/);
  assert.match(ics.ics, /DESCRIPTION:Fires at 09:30 Asia\/Kolkata/);
  assert.match(ics.ics, /\r\n/, "iCalendar lines are CRLF-separated");
}

// ---------------------------------------------------------------------------
// 2026-08-06: the .ics file itself. Three defects, measured on the real output.
// ---------------------------------------------------------------------------
const octets = (s) => new TextEncoder().encode(s).length;
{
  // 1. DTSTAMP is REQUIRED in a VEVENT (RFC 5545 3.6.1) and we were not writing
  //    one. Tolerant parsers accept the file anyway; strict ones do not.
  const ics = toICS({ freq: "monthly", day_of_month: 5, dtstart: "2026-01-05" },
    { title: "Rent", since: "2026-01-01", dtstamp: "2026-08-06T05:35:24Z" });
  assert.match(ics.ics, /\r\nDTSTAMP:20260806T053524Z\r\n/);
  assert.ok(toICS({ freq: "daily", dtstart: "2026-01-01" }, { since: "2026-01-01" }).ics.includes("DTSTAMP:"),
    "and it is still written when the caller does not pin the clock");

  // 2. Line folding at 75 octets (RFC 5545 3.1). Before this the RDATE line of a
  //    three-year export ran to 340 octets on one line.
  const long = toICS({ freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" },
    { title: "Rent", mode: "rdate", since: "2026-01-01", dtstamp: "2026-08-06T05:35:24Z" });
  const lines = long.ics.split("\r\n");
  assert.ok(lines.length > 12, "the RDATE list must actually be folded, not just short");
  for (const line of lines) assert.ok(octets(line) <= 75, `unfolded line of ${octets(line)} octets: ${line.slice(0, 40)}…`);
  // Unfolding must give the original back: a fold is CRLF + one space, and the
  // space is not part of the value.
  assert.match(long.ics.replace(/\r\n[ \t]/g, ""), /RDATE;VALUE=DATE:20260131,20260228,20260331/);

  // Folding counts OCTETS, not characters. A Devanagari title is 3 bytes a
  // letter, so a character-counting folder would emit 150-octet lines - and
  // splitting mid-sequence would corrupt the text outright.
  const utf8 = toICS({ freq: "daily", dtstart: "2026-01-01" },
    { title: "पानी पीना 💧 हर दिन बिना नागा, कोई बहाना नहीं चलेगा कभी भी", since: "2026-01-01", dtstamp: "2026-08-06T05:35:24Z" });
  for (const line of utf8.ics.split("\r\n")) assert.ok(octets(line) <= 75, `${octets(line)} octets`);
  const unfolded = utf8.ics.replace(/\r\n[ \t]/g, "");
  assert.ok(unfolded.includes("SUMMARY:पानी पीना 💧 हर दिन बिना नागा\\, कोई बहाना नहीं चलेगा कभी भी"),
    "the folded title must unfold back to itself, comma-escaped and emoji intact");
}
{
  // 3. THE DIALECT. Our clamp set is RFC-correct and rrule.js reads it right,
  //    but ical.js 2.2.1 - which is what Thunderbird ships - applies BYSETPOS
  //    only inside its BYDAY branch (recur_iterator.js next_month(), issue #960,
  //    PR #985 unmerged). MEASURED 2026-08-06 against ical.js@2.2.1:
  //      FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1 -> 38 fires in 2026,
  //      hitting the 28th, 29th, 30th AND 31st of most months, against our 12.
  //    So a rule that needs the clamp goes out as an explicit date list, which
  //    both parsers read correctly, and everything else keeps the compact
  //    infinite RRULE. (Measuring this needs UNTIL or an iteration cap: with
  //    COUNT=12 the over-expansion is truncated at 12 and looks correct.)
  const clamped = { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" };
  const safe = { freq: "quarterly", month_of_year: 1, day_of_month: 10, dtstart: "2026-01-10" };
  const nth = { freq: "monthly", nth_weekday: -1, weekday: 5, dtstart: "2026-01-30" };

  assert.equal(needsClampDialect(clamped), true);
  assert.equal(needsClampDialect(safe), false);
  assert.equal(needsClampDialect(nth), false, "BYSETPOS with BYDAY is read correctly by both; only the BYMONTHDAY pairing is not");

  const auto = toICS(clamped, { title: "Rent", since: "2026-01-01", dtstamp: "2026-08-06T05:35:24Z" });
  assert.ok(!/\r\nRRULE|\r\n RRULE/.test(auto.ics), "a clamped rule must not go out as an RRULE by default");
  assert.match(auto.ics, /RDATE;VALUE=DATE:20260131/);
  assert.ok(auto.notes.some((n) => /ical\.js/.test(n)), "and the file must say why it chose the long form");

  for (const rule of [safe, nth]) {
    const out = toICS(rule, { title: "x", since: "2026-01-01", dtstamp: "2026-08-06T05:35:24Z" });
    assert.match(out.ics.replace(/\r\n[ \t]/g, ""), /RRULE:/, "a rule with no clamp keeps the compact form");
  }
  // The RFC-correct dialect is still reachable for a caller that wants it.
  assert.match(toICS(clamped, { title: "Rent", mode: "rrule", since: "2026-01-01" }).ics, /BYSETPOS=-1/);

  // Whatever mode is used, the dates in the file are the dates the app fires on.
  const want = occurrencesBetween(clamped, "2026-01-01", "2026-12-31", 40);
  for (const mode of ["auto", "rrule", "rdate"]) {
    const out = toICS(clamped, { title: "Rent", mode, since: "2026-01-01", dtstamp: "2026-08-06T05:35:24Z" });
    const { spec } = parseICalendar(out.ics.replace(/\r\n[ \t]/g, ""));
    assert.deepEqual(expandRRuleSpec(spec, "2026-01-01", "2026-12-31"), want, `mode=${mode} exported different dates`);
  }
}
{
  // A date list that stopped at the cap is SHORTER than the rule, and silence
  // there is a reminder that quietly ends early.
  const daily = fallbackRDate({ freq: "daily", dtstart: "2026-01-01" }, { from: "2026-01-01", years: 3, cap: 50 });
  assert.equal(daily.rdate.length, 50);
  assert.ok(daily.notes.some((n) => /cut at 50/.test(n)), `expected a truncation note, got ${JSON.stringify(daily.notes)}`);
  const short = fallbackRDate({ freq: "yearly", month_of_year: 8, day_of_month: 14 }, { from: "2026-01-01", years: 3 });
  assert.deepEqual(short.notes, [], "and no note when the list is complete");
}

// A rule that cannot fire must not be exported at all - a dead entry in a real
// calendar is worse than a refusal.
{
  assert.match(toRRule({ freq: "weekly", interval: 2 }).error || "", /start date|weekday/);
  assert.match(toRRule({ freq: "yearly", day_of_month: 14 }).error || "", /anchor month/);
}

// ---------------------------------------------------------------------------
// importing a FOREIGN rule
// ---------------------------------------------------------------------------
{
  const { rule, lossy } = parseRRule("DTSTART;VALUE=DATE:20260803\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
  assert.deepEqual(lossy, []);
  assert.equal(rule.freq, "weekly");
  assert.deepEqual(rule.weekdays, [1, 3, 5]);
  assert.equal(nextOccurrence(rule, "2026-08-04"), "2026-08-05");
}
{
  const { rule } = parseRRule("DTSTART;VALUE=DATE:20260818\r\nRRULE:FREQ=MONTHLY;BYDAY=3TU");
  assert.equal(rule.nth_weekday, 3);
  assert.equal(rule.weekday, 2);
  assert.equal(nextOccurrence(rule, "2026-09-01"), "2026-09-15");
}
{
  // Our own dialect must come back as day 31, not day 28. Recognising the clamp
  // set on the way in is what makes export -> import lossless.
  const { rule, lossy } = parseRRule("DTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
  assert.deepEqual(lossy, []);
  assert.equal(rule.day_of_month, 31);
  assert.equal(nextOccurrence(rule, "2026-02-01"), "2026-02-28");
}
{
  // Something we cannot represent has to SAY so rather than silently fire wrong.
  const a = parseRRule("DTSTART;VALUE=DATE:20260101\r\nRRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO");
  assert.ok(a.lossy.some((s) => /BYWEEKNO/.test(s)), "an ignored BY-part must be reported");
  const b = parseRRule("RRULE:FREQ=HOURLY");
  assert.equal(b.rule, null);
  assert.ok(b.lossy.some((s) => /HOURLY/.test(s)));
}
{
  // A bare VEVENT with no RRULE is a one-off, not an error.
  const { rule } = parseRRule("DTSTART;VALUE=DATE:20260912");
  assert.equal(rule.freq, "once");
  assert.equal(rule.on_date, "2026-09-12");
  assert.equal(describeRule(rule), "once on 2026-09-12");
}
{
  // The loss NOBODY listed. A foreign fortnightly rule whose weeks start on
  // Monday cannot be represented by an engine whose weeks start on Sunday, and
  // no hand-written `lossy` reason covered it - the import simply fired a week
  // out from the second date on. The round-trip check names the date instead.
  const { rule, lossy } = parseRRule("DTSTART;VALUE=DATE:20260802\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=SU,WE");
  assert.ok(rule, "the rule still imports - it is representable, just not identical");
  assert.ok(lossy.some((s) => /fires on 2026-08-05 where the source fires on 2026-08-12/.test(s)),
    `expected the first divergent date to be named, got ${JSON.stringify(lossy)}`);

  // And the same rule written the way we write it round-trips clean, so the
  // check is detecting a real difference rather than flagging everything.
  const clean = parseRRule("DTSTART;VALUE=DATE:20260802\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SU,WE");
  assert.deepEqual(clean.lossy, []);
}
{
  // Every rule this codec emits must import back as itself. A hand-written list
  // of losses can only report the ones somebody thought of, so the emitter is
  // checked against its own reader across the shapes the app actually stores.
  const rules = [
    { freq: "daily", interval: 4, dtstart: "2026-03-01" },
    { freq: "weekly", weekdays: [1, 3, 5], dtstart: "2026-08-03" },
    { freq: "weekly", weekdays: [0, 3], interval: 2, dtstart: "2026-08-02" },
    { freq: "monthly", day_of_month: 31, dtstart: "2026-01-31" },
    { freq: "monthly", nth_weekday: -1, weekday: 5, dtstart: "2026-01-30" },
    { freq: "quarterly", month_of_year: 1, day_of_month: 10, dtstart: "2026-01-10" },
    { freq: "quarterly", month_of_year: 1, day_of_month: 31, dtstart: "2026-01-31" },
    { freq: "yearly", month_of_year: 8, day_of_month: 14, dtstart: "2026-08-14" },
    { freq: "yearly", month_of_year: 2, day_of_month: 29, dtstart: "2026-02-28" },
  ];
  for (const rule of rules) {
    const out = toRRule(rule, { since: rule.dtstart });
    const back = parseRRule(out.lines.join("\r\n"));
    assert.deepEqual(back.lossy, [], `${describeRule(rule)} did not survive its own round trip: ${back.lossy.join("; ")}`);
    assert.deepEqual(
      occurrencesBetween(back.rule, rule.dtstart, "2031-12-31", 60),
      occurrencesBetween(rule, rule.dtstart, "2031-12-31", 60),
      `${describeRule(rule)} imported back to different dates`,
    );
  }
}

console.log("rrule-codec tests passed: rrule.js generates the RRULE, the clamp round-trips to the same 12 dates, "
  + "and a clamped rule ships as an explicit date list because ical.js expands BYSETPOS+BYMONTHDAY to 38");
