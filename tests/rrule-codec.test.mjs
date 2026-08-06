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
  toRRule, toICS, fallbackRDate, parseICalendar, expandRRuleSpec, parseRRule,
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
  const rule = { freq: "weekly", weekday: 3, interval: 2, dtstart: "2026-08-05" };
  const ours = occurrencesBetween(rule, "2026-08-01", "2026-10-31", 20);
  const rt = roundTrip(rule, "2026-08-01", "2026-10-31");
  assert.equal(rt.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE");
  assert.deepEqual(rt.dates, ours);
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
  const third = { freq: "monthly", nth_weekday: 3, weekday: 2, dtstart: "2026-08-18" };
  const rt = roundTrip(third, "2026-08-01", "2026-12-31");
  assert.equal(rt.rrule, "FREQ=MONTHLY;BYDAY=3TU");
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

console.log("rrule-codec tests passed: clamp exports as BYSETPOS=-1 and round-trips to the same 12 dates");
