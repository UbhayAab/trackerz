// iCALENDAR IMPORT/EXPORT - fixtures from real exporters, plus a round-trip fuzz.
//
// Three things are proved here, in order of how much they matter:
//
// 1. REAL FILES PRODUCE THE EXACT RULE WE CLAIM. Google, Apple and Outlook all
//    write valid iCalendar and all write it DIFFERENTLY, so the fixtures are
//    shaped like their actual output rather than like the RFC's examples:
//    Google folds nothing and writes WKST=SU it never needs; Apple writes
//    `TZID=Asia/Calcutta` (the old Olson alias) with NO VTIMEZONE anywhere in
//    the file and splits EXDATE across several lines; Outlook writes Windows
//    zone ids in quotes (`TZID="India Standard Time"`), an all-day event as a
//    midnight-to-midnight TIMED event flagged with X-MICROSOFT-CDO-ALLDAYEVENT,
//    and folds a 500-character X-ALT-DESC HTML blob across a dozen lines.
//    Each of those is a silent wrong-date bug if it is guessed at.
//
// 2. NOTHING IS DROPPED WITHOUT A REASON. `unsupported.ics` contains six things
//    we cannot turn into a rule and the test asserts SIX problems, each naming
//    its own component. A parser that returns fewer rows and an empty problems
//    array is the failure this repo keeps rediscovering.
//
// 3. THE ROUND TRIP IS A REAL ROUND TRIP. Export -> import must give back the
//    same OCCURRENCE DATES, not merely a similar-looking object. Two rules that
//    fire on the same days are the same rule whatever their fields look like,
//    and two that do not must have said so in `problems`.
//
// Run: node tests/ics.test.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  icsToReminders, remindersToIcs, toInsertRow, ruleFingerprint, occurrenceSet,
  icsUrlToHttps, icsProxyRequest, subscriptionPlan, normalizeTzid, isKnownZone,
  fixedOffsetOf, REMINDER_COLUMNS, DEFAULT_TZ, WINDOWS_ZONES,
} from "../lib/ics.mjs";
import { ruleProblem, describeRule, occurrencesBetween } from "../lib/reminders.mjs";

// --- the vendored parser, loaded exactly the way the browser loads it --------
const VENDORED = "../vendor/ical.js/ical.js@2.2.1/index.mjs";
const ENTRY = "vendor/ical.js/ical.js@2.2.1/index.mjs";
assert.ok(existsSync(ENTRY), `missing vendored parser ${ENTRY} - run: node vendor/fetch-vendor.mjs vendor/ical.js /ical.js@2.2.1`);
const vendored = await import(pathToFileURL(ENTRY).href);
const ICAL = vendored.default || vendored;
for (const name of ["parse", "Component", "Timezone", "Time", "Recur", "stringify"]) {
  assert.equal(typeof ICAL[name], "function", `vendored ical.js has no ${name} export - the vendored file is a redirect stub, not the library`);
}
// The vendored graph must not reach back out to a CDN, and must resolve by
// relative path alone. `VENDORED` is the specifier src/ui/calendar-import.js
// uses, kept here so the two cannot drift.
assert.ok(VENDORED.endsWith("/ical.js@2.2.1/index.mjs"));
let vendorChunks = 0;
for (const file of readdirSync("vendor/ical.js", { recursive: true }).map((f) => `vendor/ical.js/${String(f).replaceAll("\\", "/")}`)) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  vendorChunks += 1;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:\bfrom\s*|\bexport\s*\*\s*from\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g)) {
    // Bare specifiers are skipped for the same reason tests/vendor-offline.test.mjs
    // skips them: a minified bundle contains import-shaped text inside string
    // literals and no regex can tell those from code. The successful import of
    // the entry above is what proves the real graph resolves.
    if (!/^(\.{1,2}\/|\/|https?:)/.test(m[2])) continue;
    assert.ok(m[2].startsWith("./") || m[2].startsWith("../"), `${file} imports non-relative "${m[2]}" - that defeats vendoring`);
    assert.ok(existsSync(`${file.replace(/\/[^/]+$/, "")}/${m[2].replace(/^\.\//, "")}`),
      `${file} imports a chunk that is not vendored: ${m[2]}`);
  }
}
assert.equal(vendorChunks, 2, `expected the 2-file ical.js graph, found ${vendorChunks}`);

const FIX = "tests/fixtures/ics";
const read = (name) => readFileSync(`${FIX}/${name}.ics`, "utf8");
const parse = (name, opts = {}) => icsToReminders(read(name), { parser: ICAL, ...opts });
const byTitle = (rows, title) => rows.find((r) => r.title === title);
const reasons = (out) => out.problems.map((p) => p.reason);
const mentions = (out, fragment) => reasons(out).some((r) => r.includes(fragment));

// A rule row compared on its RULE fields only, so a note or a uid cannot make
// two identical rules look different.
function rulePart(row) {
  const out = {};
  for (const k of ["freq", "day_of_month", "month_of_year", "weekday", "on_date",
    "rule_interval", "dtstart", "nth_weekday", "weekdays", "until", "max_count",
    "exdates", "rdates", "at_time", "timezone"]) out[k] = row[k];
  return out;
}

// ===========================================================================
// 1. Google Calendar export
// ===========================================================================
{
  const out = parse("google-export");
  assert.equal(out.stats.vevents, 3, "three VEVENTs in the file");
  assert.equal(out.stats.overrides, 1, "one of them is a RECURRENCE-ID override");
  assert.equal(out.reminders.length, 2, "the override folds into its master rather than becoming a second reminder");
  assert.equal(out.calendar.prodid, "-//Google Inc//Google Calendar 70.9054//EN");
  assert.equal(out.calendar.name, "owner@example.com");

  const review = byTitle(out.reminders, "Weekly review");
  assert.deepEqual(rulePart(review), {
    freq: "weekly", day_of_month: null, month_of_year: null, weekday: null, on_date: null,
    rule_interval: 1, dtstart: "2026-08-03", nth_weekday: null, weekdays: [1],
    until: null, max_count: null, exdates: ["2026-08-17"], rdates: null,
    at_time: "18:30", timezone: "Asia/Kolkata",
  });
  assert.equal(describeRule(review), "every Monday at 18:30, except 2026-08-17");
  // DESCRIPTION and LOCATION both land in the note; losing the location of an
  // appointment is losing the appointment.
  assert.equal(review.note, "Weekly review with the team\nWhere: Meet");
  assert.equal(review._source.uid, "1a2b3c4d5e6f7g8h9i0j@google.com");

  // The override moves the time but not the day, which one rule cannot hold.
  assert.ok(
    mentions(out, "the instance on 2026-08-24 has a different title and time"),
    `expected the same-day override to be reported, got: ${reasons(out).join(" | ")}`,
  );

  const birthday = byTitle(out.reminders, "Amma's birthday");
  assert.deepEqual(rulePart(birthday), {
    freq: "yearly", day_of_month: 14, month_of_year: 8, weekday: null, on_date: null,
    rule_interval: 1, dtstart: "2026-08-14", nth_weekday: null, weekdays: null,
    until: null, max_count: null, exdates: null, rdates: null,
    at_time: null, timezone: "Asia/Kolkata",
  });
  // Google writes DTEND = start + 1 day for a single all-day event. Read as an
  // inclusive end that is a two-day event; read correctly it is one day.
  assert.equal(birthday.kind, "birthday", "a yearly all-day event called a birthday is a birthday");
  assert.ok(!mentions(out, "runs 2 days"), "an all-day event's exclusive DTEND must not read as a multi-day span");
  assert.deepEqual(occurrenceSet(birthday, "2026-01-01", 3, 5), ["2026-08-14", "2027-08-14", "2028-08-14"]);
}

// ===========================================================================
// 2. Apple Calendar export
// ===========================================================================
{
  const out = parse("apple-export");
  assert.equal(out.reminders.length, 2);

  const physio = byTitle(out.reminders, "Physio");
  assert.deepEqual(rulePart(physio), {
    freq: "weekly", day_of_month: null, month_of_year: null, weekday: null, on_date: null,
    rule_interval: 2, dtstart: "2026-08-05", nth_weekday: null, weekdays: [3],
    until: null, max_count: null, exdates: ["2026-08-19", "2026-09-02"], rdates: null,
    at_time: "10:00", timezone: "Asia/Kolkata",
  });
  // Apple splits EXDATE across several lines instead of comma-joining them.
  // Reading only the first property silently keeps a cancelled appointment.
  assert.equal(physio.exdates.length, 2, "both of Apple's separate EXDATE lines must be read");
  // Asia/Calcutta is the old Olson name and the file carries NO VTIMEZONE for
  // it at all. ical.js alone treats that as a FLOATING time, which is a silent
  // 5.5 hour error; the resolution must be reported, and the hour kept.
  assert.ok(mentions(out, 'TZID "Asia/Calcutta" had no VTIMEZONE'), "the missing VTIMEZONE must be named");
  assert.equal(physio.at_time, "10:00", "10:00 Asia/Calcutta is 10:00 Asia/Kolkata, not 15:30");

  // The folded X-APPLE-STRUCTURED-LOCATION (three physical lines, quoted params,
  // an escaped comma inside a geo: URI) must not derail the properties after it.
  assert.equal(physio.note, "Where: Sunrise Clinic, 2nd Floor, MG Road");

  const rent = byTitle(out.reminders, "Pay the rent");
  assert.equal(rent.freq, "monthly");
  assert.equal(rent.day_of_month, 5);
  assert.equal(rent.at_time, "09:00");
}

// ===========================================================================
// 3. Outlook / Exchange export
// ===========================================================================
{
  const out = parse("outlook-export");
  assert.equal(out.reminders.length, 2);

  const gst = byTitle(out.reminders, "File quarterly GST");
  assert.ok(gst, `SUMMARY;LANGUAGE=en-gb must still be read as a summary; got ${out.reminders.map((r) => r.title).join(", ")}`);
  assert.deepEqual(rulePart(gst), {
    freq: "quarterly", day_of_month: 10, month_of_year: 10, weekday: null, on_date: null,
    rule_interval: 1, dtstart: "2026-10-10", nth_weekday: null, weekdays: null,
    until: null, max_count: null, exdates: null, rdates: null,
    at_time: "10:00", timezone: "Asia/Kolkata",
  });
  // The zone id is a WINDOWS name, not IANA. Intl has never heard of it; the
  // file's own VTIMEZONE is what makes 10:00 stay 10:00.
  assert.equal(isKnownZone("India Standard Time"), false, "Windows zone ids are not IANA - that is the whole quirk");
  assert.equal(gst.at_time, "10:00");
  assert.deepEqual(
    occurrenceSet(gst, "2026-08-01", 1, 6),
    ["2026-10-10", "2027-01-10", "2027-04-10", "2027-07-10"],
  );

  // Outlook's older all-day form: a TIMED midnight-to-midnight event with a
  // Microsoft flag. Read literally it becomes "reminds you at 00:00".
  const offsite = byTitle(out.reminders, "Company offsite");
  assert.equal(offsite.at_time, null, "X-MICROSOFT-CDO-ALLDAYEVENT means all-day, not midnight");
  assert.equal(offsite.freq, "once");
  assert.equal(offsite.on_date, "2026-08-26");
  assert.equal(offsite._source.allDay, true);
  // Outlook's UIDs are long enough to be FOLDED across two physical lines. A
  // truncated UID silently breaks every future match against this event.
  assert.equal(
    offsite._source.uid,
    "040000008200E00074C5B7101A82E0080000000011112222333344445555666677778888",
    "the folded UID must be rejoined, continuation space stripped",
  );
  assert.equal(
    gst._source.uid,
    "040000008200E00074C5B7101A82E00800000000B0F6C9A1D2E3FA01000000000000000010000000C4B1A2D3E4F5A60718293A4B5C6D7E8F9",
  );
}

// ===========================================================================
// 4. All-day, multi-day
// ===========================================================================
{
  const out = parse("all-day");
  assert.equal(out.reminders.length, 1);
  const row = out.reminders[0];
  assert.equal(row.freq, "once");
  assert.equal(row.on_date, "2026-09-01");
  assert.equal(row.at_time, null);
  assert.equal(row._source.spanDays, 1);
  assert.equal(out.problems.length, 0, `a plain all-day event has nothing to report: ${reasons(out).join(" | ")}`);
}
{
  const out = parse("multi-day");
  assert.equal(out.reminders.length, 1);
  const row = out.reminders[0];
  // DTEND is EXCLUSIVE for DATE values: 10th to 13th is a THREE day trip.
  assert.equal(row._source.spanDays, 3);
  assert.equal(row.on_date, "2026-09-10");
  assert.ok(row.note.includes("Runs 3 days, 2026-09-10 to 2026-09-12"), row.note);
  assert.ok(mentions(out, "this event runs 3 days (2026-09-10 to 2026-09-12)"),
    "a reminder is one day; losing the other two without saying so is a lie about the trip");
}

// ===========================================================================
// 5. Recurring with EXDATE, and with a RECURRENCE-ID override
// ===========================================================================
{
  const out = parse("recurring-exdate");
  assert.equal(out.reminders.length, 1);
  const gym = out.reminders[0];
  assert.deepEqual(rulePart(gym), {
    freq: "weekly", day_of_month: null, month_of_year: null, weekday: null, on_date: null,
    rule_interval: 1, dtstart: "2026-08-03", nth_weekday: null, weekdays: [1, 3, 5],
    until: "2026-12-31", max_count: null, exdates: ["2026-08-17", "2026-08-19"], rdates: null,
    at_time: null, timezone: "Asia/Kolkata",
  });
  assert.equal(gym.kind, "task", "CATEGORIES is honoured over the summary guess");
  // The two excluded days must actually be missing from the fired dates.
  const days = occurrenceSet(gym, "2026-08-10", 1, 10).slice(0, 6);
  assert.deepEqual(days, ["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-21", "2026-08-24", "2026-08-26"]);
}
{
  const out = parse("recurring-override");
  assert.equal(out.stats.vevents, 3);
  assert.equal(out.reminders.length, 1, "three VEVENTs under one UID are one rule");
  const standup = out.reminders[0];
  // The only way a rule model without per-instance overrides can hold
  // "the 17th moved to the 18th": drop the 17th, add the 18th.
  assert.deepEqual(standup.exdates, ["2026-08-17", "2026-08-31"]);
  assert.deepEqual(standup.rdates, ["2026-08-18"]);
  assert.deepEqual(
    occurrenceSet(standup, "2026-08-10", 1, 6).slice(0, 5),
    ["2026-08-10", "2026-08-18", "2026-08-24", "2026-09-07", "2026-09-14"],
  );
  assert.ok(mentions(out, "the instance on 2026-08-17 was moved to 2026-08-18"));
  assert.ok(mentions(out, "the instance on 2026-08-31 is cancelled"));
}

// ===========================================================================
// 6. DTSTART in a zone other than Asia/Kolkata
// ===========================================================================
{
  const out = parse("foreign-timezone");
  assert.equal(out.reminders.length, 2);

  // 23:30 Monday in New York is 09:00 TUESDAY in Kolkata. Keeping "23:30 Monday"
  // would fire the reminder on the wrong DAY, and jarvis evaluates every row
  // against ONE profile timezone so storing America/New_York would fire it 9.5
  // hours early instead.
  const late = byTitle(out.reminders, "New York sync");
  assert.deepEqual(rulePart(late), {
    freq: "weekly", day_of_month: null, month_of_year: null, weekday: null, on_date: null,
    rule_interval: 1, dtstart: "2026-08-11", nth_weekday: null, weekdays: [2],
    until: null, max_count: null, exdates: null, rdates: null,
    at_time: "09:00", timezone: "Asia/Kolkata",
  });
  assert.equal(late._source.shiftDays, 1);
  assert.ok(mentions(out, "in Asia/Kolkata it falls a day later"), "a moved day must be said out loud");

  // 09:30 New York is 19:00 the SAME day in Kolkata: no shift, no noise.
  const early = byTitle(out.reminders, "New York standup");
  assert.equal(early.dtstart, "2026-08-10");
  assert.deepEqual(early.weekdays, [1]);
  assert.equal(early.at_time, "19:00");
  assert.equal(early._source.shiftDays, 0);

  // Converting into a zone that is NOT the default must work too.
  const asNy = parse("foreign-timezone", { timezone: "America/New_York" });
  const keptLate = byTitle(asNy.reminders, "New York sync");
  assert.equal(keptLate.at_time, "23:30");
  assert.equal(keptLate.dtstart, "2026-08-10");
  assert.deepEqual(keptLate.weekdays, [1]);
}

// ===========================================================================
// 7. Nothing is dropped in silence
// ===========================================================================
{
  const out = parse("unsupported");
  assert.equal(out.reminders.length, 0, "none of these six can become a rule");
  const want = [
    "VTODO components are not imported",
    "VJOURNAL components are not imported",
    "FREQ=HOURLY is not supported",
    "the event has no DTSTART",
    "STATUS:CANCELLED",
    'TZID "Customized Time Zone" has no VTIMEZONE',
  ];
  for (const fragment of want) {
    assert.ok(mentions(out, fragment), `nothing reported for "${fragment}". Got:\n  ${reasons(out).join("\n  ")}`);
  }
  assert.ok(out.stats.errors >= 3, `expected hard errors, got ${out.stats.errors}`);
  // Every problem names WHICH component it is about. "Something went wrong"
  // is the same as silence.
  for (const p of out.problems) {
    assert.ok(p.component, "a problem with no component");
    assert.ok(p.reason && p.reason.length > 12, `useless reason: ${p.reason}`);
    assert.ok(["error", "warning"].includes(p.severity), `bad severity ${p.severity}`);
  }
}

// ===========================================================================
// 8. Bad input fails loudly, never as "your calendar was empty"
// ===========================================================================
{
  assert.throws(() => icsToReminders("BEGIN:VCALENDAR\r\nEND:VCALENDAR"), /injected iCalendar parser/,
    "no parser must throw, not return zero events");

  const notIcs = icsToReminders("id,amount\n1,200\n", { parser: ICAL });
  assert.equal(notIcs.reminders.length, 0);
  assert.ok(notIcs.problems.some((p) => p.reason.includes("no BEGIN:VCALENDAR")), reasons(notIcs).join(" | "));

  const broken = icsToReminders("BEGIN:VCALENDAR\r\nthis is not a property\r\nEND:VCALENDAR", { parser: ICAL });
  assert.equal(broken.reminders.length, 0);
  assert.ok(broken.problems.some((p) => p.severity === "error" && p.reason.includes("could not be parsed")), reasons(broken).join(" | "));

  const empty = icsToReminders("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR", { parser: ICAL });
  assert.equal(empty.reminders.length, 0);
  assert.equal(empty.stats.vevents, 0);
}

// ===========================================================================
// 9. LF-only files parse identically to CRLF ones
// ===========================================================================
{
  const crlf = read("google-export");
  assert.ok(crlf.includes("\r\n"), "the fixture should be authored with real CRLF endings");
  const lf = icsToReminders(crlf.replace(/\r\n/g, "\n"), { parser: ICAL });
  const asIs = icsToReminders(crlf, { parser: ICAL });
  assert.deepEqual(lf.reminders.map(rulePart), asIs.reminders.map(rulePart),
    "a file that lost its carriage returns in transit must still import the same rules");
}

// ===========================================================================
// 10. toInsertRow is the ONLY step between preview and write
// ===========================================================================
{
  const out = parse("google-export");
  for (const item of out.reminders) {
    const row = toInsertRow(item);
    assert.ok(!("_source" in row), "provenance must not be sent to the database");
    for (const col of REMINDER_COLUMNS) {
      assert.deepEqual(row[col], item[col], `toInsertRow changed ${col} - the preview and the write would disagree`);
    }
    assert.deepEqual(Object.keys(row).sort(), [...REMINDER_COLUMNS].sort(),
      "toInsertRow must emit exactly the reminders columns");
    // The row shown in the preview and the row inserted describe identically.
    assert.equal(describeRule(row), describeRule(item));
    assert.equal(ruleProblem(row), null, `an unusable row got through: ${ruleProblem(row)}`);
  }
}

// ===========================================================================
// 11. Export: shape, validity, and re-parse by ical.js itself
// ===========================================================================
{
  const rows = parse("google-export").reminders;
  const { ics, problems, exported, skipped } = remindersToIcs(rows, { since: "2026-08-01", now: new Date("2026-08-06T00:00:00Z") });
  assert.equal(exported, 2);
  assert.equal(skipped, 0);
  assert.deepEqual(problems, []);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"), "an .ics is CRLF-delimited");
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  assert.ok(ics.includes("BEGIN:VTIMEZONE"), "a timed event needs its zone defined in the file");
  assert.ok(ics.includes("TZID:Asia/Kolkata"));
  // DTSTAMP is REQUIRED in a VEVENT (RFC 5545 3.6.1). Tolerant parsers accept a
  // file without it, which is why its absence goes unnoticed until an Exchange
  // import path rejects the whole calendar.
  assert.equal((ics.match(/\r\nDTSTAMP:/g) || []).length, 2, "every VEVENT needs a DTSTAMP");
  assert.ok(/DTSTAMP:20260806T000000Z/.test(ics), "DTSTAMP must be injectable so a test can pin it");
  assert.ok(!ics.includes("STATUS:CANCELLED"), "an export must never tell a subscriber to delete an event");
  for (const line of ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line over 75 octets: ${line}`);
  }
  // ical.js is a third party: if IT can read our file, so can Thunderbird.
  const reparsed = new ICAL.Component(ICAL.parse(ics));
  assert.equal(reparsed.name, "vcalendar");
  assert.equal(reparsed.getAllSubcomponents("vevent").length, 2);

  // A long summary is folded on a UTF-8 boundary, not mid-character.
  const long = remindersToIcs([{ ...rows[0], title: `भारत ${"आयकर विवरणी दाखिल करने की अंतिम तिथि ".repeat(4)}` }], { since: "2026-08-01" });
  for (const line of long.ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `folded line over 75 octets: ${line}`);
  }
  const foldedBack = new ICAL.Component(ICAL.parse(long.ics));
  assert.ok(foldedBack.getFirstSubcomponent("vevent").getFirstPropertyValue("summary").includes("भारत"),
    "folding split a multi-byte character");
}

// ===========================================================================
// 12. Export refuses in the open, and carries COUNT off a DB row
// ===========================================================================
{
  const dead = remindersToIcs([{ title: "Broken", freq: "weekly" }], { since: "2026-08-01" });
  assert.equal(dead.exported, 0);
  assert.equal(dead.skipped, 1);
  assert.ok(dead.problems.some((p) => p.severity === "error" && p.reason.includes("weekly needs at least one weekday")),
    dead.problems.map((p) => p.reason).join(" | "));
  assert.ok(!dead.ics.includes("BEGIN:VEVENT"), "nothing was written for it");

  // `count` is spelled max_count in Postgres (`count` is an aggregate). A row
  // read straight from PostgREST therefore has max_count and no count, and an
  // exporter that reads only `count` publishes a series that never ends.
  const capped = remindersToIcs(
    [{ title: "Six sessions", freq: "weekly", weekdays: [2], dtstart: "2026-08-04", max_count: 6 }],
    { since: "2026-08-01" },
  );
  assert.ok(/RRULE:[^\r\n]*COUNT=6/.test(capped.ics), `max_count was dropped from the export:\n${capped.ics}`);

  const both = remindersToIcs(
    [{ title: "Both", freq: "weekly", weekdays: [2], dtstart: "2026-08-04", max_count: 6, until: "2026-12-31" }],
    { since: "2026-08-01" },
  );
  assert.ok(both.problems.some((p) => p.reason.includes("only one per RRULE")),
    "dropping UNTIL to keep COUNT must be reported");
}

// ===========================================================================
// 12b. THE BYSETPOS TRAP - the one bug that would make a green test lie
//
// ical.js 2.2.1 parses `BYMONTHDAY=28,29,30,31;BYSETPOS=-1` perfectly and then
// IGNORES the BYSETPOS when expanding it (issue #960, PR #985 unmerged): the
// set-position code in `next_month()` sits inside the BYDAY branch, so the
// BYMONTHDAY-only path never reaches it. That dialect is exactly what
// lib/rrule-codec.mjs emits for our clamped "the 31st" rule, and ical.js is the
// engine inside Thunderbird. Measured below, not assumed.
//
// This is also why the round-trip fuzz uses OUR expander and never ical.js's:
// a test that expanded both sides with ical.js would agree with itself and
// prove nothing.
// ===========================================================================
{
  const CLAMP = "FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1";
  const expandWithIcal = (rrule, startKey, cap) => {
    const iter = ICAL.Recur.fromString(rrule).iterator(ICAL.Time.fromDateString(startKey));
    const out = [];
    let next;
    while ((next = iter.next()) && out.length < cap) out.push(next.toString().slice(0, 10));
    return out;
  };

  // It round-trips the STRING faithfully, which is what makes the bug nasty.
  assert.equal(ICAL.Recur.fromString(CLAMP).toString(), CLAMP);
  const icalDates = expandWithIcal(CLAMP, "2026-01-31", 60).filter((d) => d.startsWith("2026"));
  assert.equal(icalDates.length, 38,
    `ical.js 2.2.1 is expected to expand the clamp dialect to 38 dates in 2026 (issue #960). It gave ${icalDates.length}. `
    + "If this is now 12 the bug is fixed upstream - delete this assertion and the RDATE dialect switch in lib/ics.mjs may be reverted.");
  // BYSETPOS with BYDAY is fine, so the hole is specific to BYMONTHDAY.
  assert.equal(expandWithIcal("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-01-30", 40).filter((d) => d.startsWith("2026")).length, 12);

  // OUR import of that same dialect is right, because lib/rrule-codec.mjs
  // recognises it as the clamp set rather than expanding it with ical.js.
  const viaRrule = parse("clamp-rrule-dialect");
  assert.equal(viaRrule.reminders.length, 1);
  assert.equal(viaRrule.reminders[0].freq, "monthly");
  assert.equal(viaRrule.reminders[0].day_of_month, 31);
  const wanted2026 = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30",
    "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31"];
  assert.deepEqual(occurrencesBetween(viaRrule.reminders[0], "2026-01-01", "2026-12-31", 40), wanted2026);

  // BOTH dialects import to the same 12 days, whichever one we end up emitting.
  const viaRdate = parse("clamp-rdate-dialect");
  assert.equal(viaRdate.reminders.length, 1);
  assert.equal(viaRdate.reminders[0].freq, "once", "an explicit date list has no repeat rule to read");
  assert.deepEqual(occurrencesBetween(viaRdate.reminders[0], "2026-01-01", "2026-12-31", 40), wanted2026,
    "the RDATE dialect must produce the same dates as the RRULE dialect");
  // The RDATE list is folded across two physical lines in the fixture; reading
  // only the first would silently drop half the year.
  assert.equal(viaRdate.reminders[0].rdates.length, 12);

  // ...and our EXPORT of a clamped rule must not hand Thunderbird the broken
  // form. This is the assertion that would have caught the whole thing.
  const clamped = { title: "Last day of the month", freq: "monthly", day_of_month: 31, dtstart: "2026-01-31", kind: "filing", lead_days: 0, active: true, timezone: DEFAULT_TZ };
  const out = remindersToIcs([clamped], { since: "2026-01-01", now: new Date("2026-08-06T00:00:00Z") });
  assert.ok(!out.ics.includes("BYSETPOS"), `our export still emits the dialect ical.js mis-expands:\n${out.ics}`);
  assert.ok(out.ics.includes("RDATE"), "the clamped rule should become an explicit date list");
  assert.equal(out.dialects.rdate, 1);
  assert.equal(out.dialects.rrule, 0);
  assert.ok(out.problems.some((p) => p.reason.includes("38")), "the switch must say why it happened");
  // A 36-date RDATE list is ~330 octets on one logical line. Unfolded, that is
  // the 349-octet line the audit measured on the old exporter.
  assert.ok(out.ics.includes("\r\n "), "the long RDATE list must be folded, not emitted as one line");
  for (const line of out.ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line over 75 octets: ${line}`);
  }
  assert.ok(out.ics.includes("DTSTAMP:20260806T000000Z"));

  // The proof: ical.js's OWN reading of our file now gives the right 12 days.
  const theirs = new ICAL.Component(ICAL.parse(out.ics)).getFirstSubcomponent("vevent");
  const theirDates = [];
  for (const prop of theirs.getAllProperties("rdate")) {
    for (const v of prop.getValues()) theirDates.push(v.toString().slice(0, 10));
  }
  assert.deepEqual(theirDates.filter((d) => d.startsWith("2026")), wanted2026,
    "Thunderbird must read our clamped rule as 12 days in 2026");

  // Forcing the compact form is allowed, and says what it costs.
  const forced = remindersToIcs([clamped], { since: "2026-01-01", dialect: "rrule" });
  assert.ok(forced.ics.includes("BYSETPOS"));
  assert.ok(forced.problems.some((p) => p.reason.includes("parses but does not apply")));

  // A rule needing no BYSETPOS keeps the compact form, so the file stays small
  // and keeps recurring forever.
  const plain = remindersToIcs([{ title: "Rent", freq: "monthly", day_of_month: 5, dtstart: "2026-01-05", active: true }], { since: "2026-01-01" });
  assert.ok(plain.ics.includes("RRULE:FREQ=MONTHLY;BYMONTHDAY=5"));
  assert.equal(plain.dialects.rrule, 1);
  assert.equal(plain.dialects.rdate, 0);
}

// ===========================================================================
// 13. Round trip on the fixtures
// ===========================================================================
for (const name of ["google-export", "apple-export", "outlook-export", "all-day",
  "multi-day", "recurring-exdate", "recurring-override", "foreign-timezone"]) {
  const first = parse(name);
  const written = remindersToIcs(first.reminders, { since: "2026-08-01", now: new Date("2026-08-06T00:00:00Z") });
  const second = icsToReminders(written.ics, { parser: ICAL });
  assert.equal(second.reminders.length, first.reminders.length, `${name}: lost a reminder on the way back`);
  for (let i = 0; i < first.reminders.length; i++) {
    const a = first.reminders[i];
    const b = second.reminders.find((r) => r.title === a.title);
    assert.ok(b, `${name}: "${a.title}" did not come back`);
    assert.equal(ruleFingerprint(b), ruleFingerprint(a), `${name}: "${a.title}" changed shape`);
    assert.deepEqual(
      occurrenceSet(b, a.dtstart || a.on_date, 3, 60),
      occurrenceSet(a, a.dtstart || a.on_date, 3, 60),
      `${name}: "${a.title}" fires on different days after a round trip`,
    );
    assert.equal(b.kind, a.kind, `${name}: "${a.title}" lost its kind`);
    assert.equal(b.note, a.note, `${name}: "${a.title}" lost its note`);
    assert.equal(b.at_time, a.at_time);
    assert.equal(b.timezone, a.timezone);
    assert.equal(b.lead_days, a.lead_days);
  }
}

// ===========================================================================
// 14. Round-trip fuzz
//
// Two pools. POOL A is the shape the importer itself produces, and must round
// trip EXACTLY - if it does not, every calendar this app imports is corrupted
// by its own export. POOL B is arbitrary: the dates it fires on must survive,
// or the export must have NAMED the loss. "Quietly different" is the one
// outcome that is not allowed.
// ===========================================================================
{
  // A tiny deterministic PRNG - a fuzz that fails only on some runs is a fuzz
  // nobody can bisect.
  let seed = 20260806;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)) % (hi - lo + 1);

  const dateKey = () => {
    const y = 2026 + int(0, 1);
    const m = int(1, 12);
    const d = int(1, 28);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  const dow = (key) => new Date(`${key}T00:00:00Z`).getUTCDay();

  function nativeRule() {
    // Exactly what icsToReminders emits: a dtstart, a freq, parts derived from
    // that dtstart, and at most one of until/count.
    const dtstart = dateKey();
    const [y, m, d] = dtstart.split("-").map(Number);
    const freq = pick(["once", "daily", "weekly", "monthly", "quarterly", "yearly"]);
    const rule = { title: `fuzz ${freq} ${dtstart}`, freq, dtstart, rule_interval: 1, timezone: DEFAULT_TZ, lead_days: 0, active: true, kind: "appointment" };
    if (freq === "once") { rule.on_date = dtstart; return rule; }
    if (freq === "daily") rule.rule_interval = int(1, 4);
    if (freq === "weekly") {
      rule.rule_interval = int(1, 3);
      rule.weekdays = [...new Set([dow(dtstart), ...(rnd() < 0.4 ? [int(0, 6)] : [])])].sort((a, b) => a - b);
    }
    if (freq === "monthly") { rule.day_of_month = d; rule.rule_interval = pick([1, 2, 4]); }
    if (freq === "quarterly") { rule.day_of_month = d; rule.month_of_year = m; }
    if (freq === "yearly") { rule.day_of_month = d; rule.month_of_year = m; }
    if (rnd() < 0.3) rule.exdates = [dtstart];
    if (rnd() < 0.2) rule.rdates = [`${y + 1}-${String(m).padStart(2, "0")}-15`];
    if (rnd() < 0.25) rule.until = `${y + 2}-12-31`;
    else if (rnd() < 0.25) rule.max_count = int(2, 9);
    if (rnd() < 0.5) rule.at_time = `${String(int(0, 23)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`;
    return rule;
  }

  function wildRule() {
    const dtstart = dateKey();
    const freq = pick(["once", "daily", "weekly", "monthly", "quarterly", "yearly"]);
    const rule = {
      title: `wild ${freq}`, freq, dtstart, timezone: DEFAULT_TZ, kind: "task", lead_days: int(0, 7), active: true,
      rule_interval: int(1, 4),
      day_of_month: int(1, 31),
      month_of_year: int(1, 12),
      weekdays: rnd() < 0.6 ? [int(0, 6)] : null,
      on_date: freq === "once" ? dtstart : null,
      at_time: rnd() < 0.5 ? `${String(int(0, 23)).padStart(2, "0")}:30` : null,
    };
    if (rnd() < 0.25) { rule.nth_weekday = pick([1, 2, 3, -1]); rule.weekdays = [int(0, 6)]; }
    if (rnd() < 0.3) rule.exdates = [dtstart];
    if (rnd() < 0.2) rule.until = "2028-06-30";
    if (rnd() < 0.2) rule.max_count = int(2, 12);
    return rule;
  }

  const tally = { nativeChecked: 0, wildChecked: 0, wildWarned: 0, refused: 0 };

  for (let i = 0; i < 400; i++) {
    const pool = i < 250 ? "native" : "wild";
    const rule = pool === "native" ? nativeRule() : wildRule();
    if (ruleProblem(rule)) { tally.refused += 1; continue; }

    const written = remindersToIcs([rule], { since: rule.dtstart, now: new Date("2026-08-06T00:00:00Z") });
    if (written.exported === 0) {
      // Refusing is allowed; refusing in silence is not.
      assert.ok(written.problems.some((p) => p.severity === "error"),
        `a rule was dropped from the export with no problem recorded: ${JSON.stringify(rule)}`);
      tally.refused += 1;
      continue;
    }
    const back = icsToReminders(written.ics, { parser: ICAL });
    assert.equal(back.reminders.length, 1, `round trip lost the event: ${JSON.stringify(rule)}\n${written.ics}`);
    const got = back.reminders[0];

    const from = rule.dtstart;
    const before = occurrencesBetween(rule, from, "2029-12-31", 40);
    const after = occurrencesBetween(got, from, "2029-12-31", 40);
    const sameDates = JSON.stringify(before) === JSON.stringify(after);
    const sameShape = ruleFingerprint(got) === ruleFingerprint(rule);

    if (pool === "native") {
      tally.nativeChecked += 1;
      assert.ok(sameShape,
        `NATIVE rule changed shape through our own export:\n  in  ${ruleFingerprint(rule)}\n  out ${ruleFingerprint(got)}\n${written.ics}`);
      assert.ok(sameDates,
        `NATIVE rule fires on different days after a round trip:\n  in  ${before.join(",")}\n  out ${after.join(",")}\n${written.ics}`);
    } else {
      tally.wildChecked += 1;
      if (!sameDates) {
        // The loss may be on either leg - the exporter dropping a modifier, or
        // the importer unable to express what came back. Either is allowed;
        // neither is allowed to be quiet.
        const said = [...written.problems, ...back.problems];
        assert.ok(said.length > 0,
          `a rule came back firing on different days with NOTHING reported on either leg:\n  ${JSON.stringify(rule)}\n  in  ${before.join(",")}\n  out ${after.join(",")}\n${written.ics}`);
        tally.wildWarned += 1;
      }
    }
  }

  assert.ok(tally.nativeChecked >= 150, `too few native rules exercised: ${tally.nativeChecked}`);
  assert.ok(tally.wildChecked >= 80, `too few wild rules exercised: ${tally.wildChecked}`);
  // A test that warns about everything proves nothing.
  assert.ok(tally.wildWarned <= tally.wildChecked * 0.5,
    `${tally.wildWarned} of ${tally.wildChecked} wild rules needed a warning - the exporter is losing too much`);
  console.log(`  fuzz: ${tally.nativeChecked} native + ${tally.wildChecked} wild round trips, ${tally.wildWarned} lossy-but-reported, ${tally.refused} refused`);
}

// ===========================================================================
// 15. Timezone helpers
// ===========================================================================
{
  assert.equal(normalizeTzid("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(normalizeTzid("Asia/Calcutta"), "Asia/Calcutta", "the old alias is still a real zone");
  assert.equal(normalizeTzid('"India Standard Time"'), "Asia/Kolkata", "quoted Windows ids are unquoted first");
  assert.equal(normalizeTzid("Pacific Standard Time"), "America/Los_Angeles");
  assert.equal(normalizeTzid("/mozilla.org/20050126_1/Europe/Paris"), "Europe/Paris");
  assert.equal(normalizeTzid("Customized Time Zone"), null, "an unmappable id must be null, never a guess");
  assert.equal(normalizeTzid(""), null);
  assert.equal(normalizeTzid(null), null);
  for (const [win, iana] of Object.entries(WINDOWS_ZONES)) {
    assert.ok(isKnownZone(iana), `WINDOWS_ZONES maps ${win} to ${iana}, which Intl does not know`);
  }
  assert.equal(fixedOffsetOf("Asia/Kolkata"), "+0530");
  assert.equal(fixedOffsetOf("UTC"), "+0000");
  assert.equal(fixedOffsetOf("America/New_York"), null, "a DST zone has no single offset to write");
  assert.equal(fixedOffsetOf("Nowhere/Fake"), null);

  // An unknown TARGET zone falls back to the default and says so.
  const out = icsToReminders(read("all-day"), { parser: ICAL, timezone: "Mars/Olympus" });
  assert.equal(out.stats.timezone, DEFAULT_TZ);
  assert.ok(out.problems.some((p) => p.reason.includes("Mars/Olympus")), reasons(out).join(" | "));
}

// ===========================================================================
// 16. Subscribable URLs
// ===========================================================================
{
  assert.equal(icsUrlToHttps("webcal://p24.calendar.icloud.com/published/2/ABC").url,
    "https://p24.calendar.icloud.com/published/2/ABC");
  assert.equal(icsUrlToHttps("WEBCAL://example.com/a.ics").url, "https://example.com/a.ics");
  assert.equal(icsUrlToHttps("https://example.com/a.ics").url, "https://example.com/a.ics");
  assert.equal(icsUrlToHttps("http://example.com/a.ics").url, "https://example.com/a.ics");
  assert.ok(icsUrlToHttps("http://example.com/a.ics").note.includes("upgraded"));
  assert.ok(icsUrlToHttps("ftp://example.com/a.ics").error);
  assert.ok(icsUrlToHttps("").error);
  assert.ok(icsUrlToHttps("javascript:alert(1)").error, "only http(s)/webcal may become a fetch");

  const req = icsProxyRequest("webcal://example.com/a.ics", { etag: 'W/"abc"' });
  assert.equal(req.endpoint, "gcal");
  assert.equal(req.body.action, "fetch_ics");
  assert.equal(req.body.url, "https://example.com/a.ics");
  assert.equal(req.body.etag, 'W/"abc"');
  assert.ok(icsProxyRequest("nonsense").error);
}

// ===========================================================================
// 17. Refreshing from a subscription
// ===========================================================================
{
  const incoming = parse("google-export").reminders;
  const fresh = subscriptionPlan({ incoming, existing: [], sourceUrl: "https://example.com/a.ics" });
  assert.equal(fresh.create.length, 2);
  assert.equal(fresh.update.length, 0);
  assert.equal(fresh.gone.length, 0);

  // Second run over the same feed changes nothing.
  const existing = incoming.map((r, i) => ({ ...r, id: `row-${i}` }));
  const again = subscriptionPlan({ incoming, existing });
  assert.equal(again.create.length, 0);
  assert.equal(again.unchanged.length, 2);
  assert.equal(again.gone.length, 0, "a stable feed must not churn the calendar");

  // A changed rule is an UPDATE against the same id, matched on the source UID.
  const moved = incoming.map((r) => (r.title === "Weekly review" ? { ...r, at_time: "19:00" } : r));
  const plan = subscriptionPlan({ incoming: moved, existing });
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].id, "row-0");
  assert.equal(plan.unchanged.length, 1);

  // An event the feed no longer carries is DEACTIVATE, never delete: a
  // truncated download and an emptied calendar look identical from here.
  const shrunk = subscriptionPlan({ incoming: [incoming[0]], existing });
  assert.equal(shrunk.gone.length, 1);
  assert.equal(shrunk.gone[0].id, "row-1");
  assert.ok(!("delete" in shrunk), "the plan must not offer a delete list");

  // A feed that regenerates its UIDs every publish must not recreate everything.
  const noUid = incoming.map((r) => ({ ...r, _source: { ...r._source, uid: null } }));
  const stable = subscriptionPlan({ incoming: noUid, existing: noUid.map((r, i) => ({ ...r, id: `x${i}` })) });
  assert.equal(stable.create.length, 0, "identity must fall back to the rule itself when there is no UID");
  assert.equal(stable.unchanged.length, 2);
}

// ===========================================================================
// 18. The UI's preview and its write are the SAME rows
//
// This is the whole discipline of the bank-statement importer, applied here.
// The module is imported in plain Node on purpose: nothing in it may touch the
// DOM at module scope, or it could never be tested without a browser.
// ===========================================================================
{
  const ui = await import("../src/ui/calendar-import.js");

  // The specifier the browser uses must point at the file that exists.
  assert.equal(
    ui.VENDORED_ICAL.replace("../../", ""),
    ENTRY,
    "src/ui/calendar-import.js points at a parser that is not vendored",
  );

  const preview = ui.previewFromIcs(read("google-export"), ICAL);
  assert.equal(preview.reminders.length, 2);
  assert.equal(preview.lines.length, preview.reminders.length, "one English line per row, index for index");
  assert.equal(preview.lines[0].rule, describeRule(preview.reminders[0]),
    "the preview text must be read off the row that gets written");
  for (const line of preview.lines) assert.equal(line.unusable, null, `preview offered a rule that cannot fire: ${line.unusable}`);

  // Add writes exactly what the preview listed, in order, with nothing else.
  const written = [];
  const report = await ui.commitPreview(preview, async (row) => { written.push(row); return { id: `new-${written.length}` }; });
  assert.equal(report.added, 2);
  assert.equal(report.failed, 0);
  assert.deepEqual(written, preview.reminders.map(toInsertRow),
    "the rows written are not the rows previewed");
  for (const row of written) {
    assert.ok(!("_source" in row), "provenance leaked into the insert");
    assert.equal(ruleProblem(row), null);
  }

  // A write that fails is counted and named, never swallowed.
  const flaky = await ui.commitPreview(preview, async (row) => {
    if (row.title === "Amma's birthday") throw new Error("row-level security");
    return { id: "ok" };
  });
  assert.equal(flaky.added, 1);
  assert.equal(flaky.failed, 1);
  assert.ok(flaky.problems[0].reason.includes("row-level security"), flaky.problems[0].reason);
  assert.ok(flaky.problems[0].reason.includes("Amma's birthday"), "the failure must name the reminder that was lost");

  // The preview HTML shows every problem, not a count.
  const noisy = ui.previewFromIcs(read("unsupported"), ICAL);
  const html = ui.renderPreview(noisy);
  for (const p of noisy.problems) {
    assert.ok(html.includes(ui.escapeHtml(p.reason)), `problem hidden from the preview: ${p.reason}`);
  }
  assert.ok(ui.renderError("boom").includes("boom"));
  // Nothing on screen may be raw user text.
  assert.ok(!ui.renderPreview(ui.previewFromIcs(
    read("all-day").replace("SUMMARY:Passport renewal appointment", "SUMMARY:<script>alert(1)</script>"), ICAL,
  )).includes("<script>"), "an event title is untrusted text from someone else's calendar");

  // Export goes through the same builder the button uses.
  const built = ui.buildExport(preview.reminders, { since: "2026-08-01", now: new Date("2026-08-06T00:00:00Z") });
  assert.equal(built.exported, 2);
  assert.ok(built.ics.includes("BEGIN:VCALENDAR"));
  assert.ok(built.ics.includes("X-WR-CALNAME:Trackerz reminders"));

  // A subscription URL cannot be fetched from the browser, so the fetcher is
  // injected. The refresh must produce a PLAN, not writes.
  const plan = await ui.refreshFromIcsUrl("webcal://example.com/cal.ics", {
    parser: ICAL,
    existing: [],
    fetchIcs: async (request) => {
      assert.equal(request.endpoint, "gcal");
      assert.equal(request.body.action, "fetch_ics");
      assert.equal(request.body.url, "https://example.com/cal.ics");
      return read("google-export");
    },
  });
  assert.equal(plan.plan.create.length, 2);
  assert.equal(plan.plan.gone.length, 0);
  assert.equal(plan.preview.reminders.length, 2);

  await assert.rejects(
    () => ui.refreshFromIcsUrl("not-a-url", { parser: ICAL, existing: [] }),
    /not a calendar URL/,
  );
  await assert.rejects(
    () => ui.refreshFromIcsUrl("https://example.com/cal.ics", { parser: ICAL, existing: [], fetchIcs: async () => "" }),
    /returned nothing that looks like a calendar/,
    "an empty response must not read as an empty calendar",
  );
}

console.log(
  "ics tests passed: 11 fixtures (Google/Apple/Outlook/all-day/multi-day/EXDATE/RECURRENCE-ID/foreign-zone/unsupported"
  + "/clamp-RRULE/clamp-RDATE), the ical.js #960 BYSETPOS regression, export validity, 400-rule round-trip fuzz",
);
