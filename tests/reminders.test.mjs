import assert from "node:assert/strict";
import {
  nextOccurrence, occurrencesBetween, describeRule, dueReminders, upcoming,
  whenLabel, reminderLines, weekdayOf, addDays, daysBetween, clampDay, isLeapYear, daysInMonth,
  occurrenceKey, timedDue, agendaBetween, ruleProblem, weekdayList, nthWeekdayOfMonth,
  minutesOfDay, formatTime, weekIndex,
} from "../lib/reminders.mjs";

// ---------------------------------------------------------------------------
// date primitives - no Date object anywhere, so these must be right on their own
// ---------------------------------------------------------------------------
assert.equal(isLeapYear(2024), true);
assert.equal(isLeapYear(2026), false);
assert.equal(isLeapYear(2000), true);
assert.equal(isLeapYear(1900), false);
assert.equal(daysInMonth(2026, 2), 28);
assert.equal(daysInMonth(2028, 2), 29);

assert.equal(weekdayOf("2026-08-05"), 3, "2026-08-05 is a Wednesday");
assert.equal(weekdayOf("2026-08-14"), 5, "2026-08-14 is a Friday");

assert.equal(addDays("2026-08-31", 1), "2026-09-01");
assert.equal(addDays("2026-01-01", -1), "2025-12-31");
assert.equal(addDays("2026-02-28", 1), "2026-03-01", "2026 is not a leap year");
assert.equal(addDays("2028-02-28", 1), "2028-02-29", "2028 is");
assert.equal(daysBetween("2026-08-05", "2026-08-14"), 9);
assert.equal(daysBetween("2026-08-05", "2027-08-05"), 365);

// A date that does not exist clamps to the month end rather than rolling PAST
// itself - moving a tax deadline forward is the one direction that costs money.
assert.equal(clampDay(2026, 2, 31), 28);
assert.equal(clampDay(2028, 2, 29), 29);
assert.equal(clampDay(2026, 4, 31), 30);

// ---------------------------------------------------------------------------
// THE BIRTHDAY CASE, stated out loud: "birth date is 14 August" must fire EVERY
// year, not once.
// ---------------------------------------------------------------------------
{
  const bday = { freq: "yearly", month_of_year: 8, day_of_month: 14, title: "Birthday" };
  assert.equal(nextOccurrence(bday, "2026-08-05"), "2026-08-14", "nine days away");
  assert.equal(nextOccurrence(bday, "2026-08-14"), "2026-08-14", "ON the day it is due today, not next year");
  assert.equal(nextOccurrence(bday, "2026-08-15"), "2027-08-14", "the day after, it rolls to next year");
  assert.equal(nextOccurrence(bday, "2027-01-01"), "2027-08-14");
  assert.equal(nextOccurrence(bday, "2030-12-31"), "2031-08-14", "still firing years later");
  assert.deepEqual(
    occurrencesBetween(bday, "2026-01-01", "2029-12-31"),
    ["2026-08-14", "2027-08-14", "2028-08-14", "2029-08-14"],
    "one per year, forever",
  );
  assert.equal(describeRule(bday), "every 14th August");
}

// A 29 February birthday lands on 28 Feb in a common year and 29 Feb in a leap one.
{
  const leap = { freq: "yearly", month_of_year: 2, day_of_month: 29 };
  assert.equal(nextOccurrence(leap, "2026-01-01"), "2026-02-28");
  assert.equal(nextOccurrence(leap, "2028-01-01"), "2028-02-29");
}

// ---------------------------------------------------------------------------
// THE GST CASE, from the note: "deadline is the 10th of Jan/Apr/Jul/Oct"
// ---------------------------------------------------------------------------
{
  const gst = { freq: "quarterly", month_of_year: 1, day_of_month: 10, title: "File quarterly GST", lead_days: 7 };
  assert.equal(nextOccurrence(gst, "2026-08-05"), "2026-10-10", "next quarter end from today");
  assert.equal(nextOccurrence(gst, "2026-10-10"), "2026-10-10", "due on the day itself");
  assert.equal(nextOccurrence(gst, "2026-10-11"), "2027-01-10", "rolls across the year boundary");
  assert.equal(nextOccurrence(gst, "2026-12-31"), "2027-01-10", "December reaches January");
  assert.deepEqual(
    occurrencesBetween(gst, "2026-01-01", "2026-12-31"),
    ["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"],
    "exactly the four filing dates the note names",
  );
  assert.equal(describeRule(gst), "the 10th of Jan/Apr/Jul/Oct");

  // The lead window is what makes it useful: 7 days of warning, not a same-day surprise.
  assert.equal(dueReminders([gst], "2026-10-02").length, 0, "8 days out - silent");
  assert.equal(dueReminders([gst], "2026-10-03").length, 1, "7 days out - starts warning");
  assert.equal(dueReminders([gst], "2026-10-10").length, 1, "and on the day");
  assert.equal(dueReminders([gst], "2026-10-11").length, 0, "and stops after");
}

// ---------------------------------------------------------------------------
// the other frequencies
// ---------------------------------------------------------------------------
assert.equal(nextOccurrence({ freq: "once", on_date: "2026-09-12" }, "2026-08-05"), "2026-09-12");
assert.equal(nextOccurrence({ freq: "once", on_date: "2026-07-01" }, "2026-08-05"), null, "a passed one-off never fires again");
assert.equal(nextOccurrence({ freq: "daily" }, "2026-08-05"), "2026-08-05");
assert.equal(nextOccurrence({ freq: "weekly", weekday: 1 }, "2026-08-05"), "2026-08-10", "next Monday");
assert.equal(nextOccurrence({ freq: "weekly", weekday: 3 }, "2026-08-05"), "2026-08-05", "today IS Wednesday");
assert.equal(nextOccurrence({ freq: "monthly", day_of_month: 5 }, "2026-08-05"), "2026-08-05");
assert.equal(nextOccurrence({ freq: "monthly", day_of_month: 3 }, "2026-08-05"), "2026-09-03");
assert.equal(nextOccurrence({ freq: "monthly", day_of_month: 31 }, "2026-09-01"), "2026-09-30", "clamped, not rolled");
assert.equal(describeRule({ freq: "monthly", day_of_month: 5 }), "the 5th of every month");
assert.equal(describeRule({ freq: "weekly", weekday: 1 }), "every Monday");

// Unusable rules return null rather than guessing a date.
assert.equal(nextOccurrence({ freq: "yearly", day_of_month: 14 }, "2026-08-05"), null, "no month");
assert.equal(nextOccurrence({ freq: "weekly", weekday: 9 }, "2026-08-05"), null);
assert.equal(nextOccurrence({ freq: "nonsense" }, "2026-08-05"), null);
assert.equal(nextOccurrence({ freq: "yearly", month_of_year: 8, day_of_month: 14 }, "garbage"), null);

// ---------------------------------------------------------------------------
// selection + phrasing
// ---------------------------------------------------------------------------
{
  const list = [
    { id: "a", title: "Birthday", freq: "yearly", month_of_year: 8, day_of_month: 14, lead_days: 1 },
    { id: "b", title: "File quarterly GST", freq: "quarterly", month_of_year: 1, day_of_month: 10, lead_days: 7 },
    { id: "c", title: "Rent", freq: "monthly", day_of_month: 5, lead_days: 0 },
    { id: "d", title: "Old thing", freq: "once", on_date: "2020-01-01" },
    { id: "e", title: "Disabled", freq: "daily", active: false },
  ];
  const up = upcoming(list, "2026-08-05", { limit: 5 });
  assert.deepEqual(up.map((r) => r.id), ["c", "a", "b"], "soonest first; passed and inactive excluded");
  assert.equal(up[0].next_due_on, "2026-08-05");
  assert.equal(up[0].days_away, 0);
  assert.equal(up[1].days_away, 9);

  const due = dueReminders(list, "2026-08-05");
  assert.deepEqual(due.map((r) => r.id), ["c"], "only rent is inside its lead window today");
  assert.deepEqual(dueReminders(list, "2026-08-13").map((r) => r.id), ["a"], "birthday warns one day out");

  assert.equal(whenLabel(0), "today");
  assert.equal(whenLabel(1), "tomorrow");
  assert.equal(whenLabel(3), "in 3 days");
  assert.equal(whenLabel(21), "in 3 weeks");
  assert.deepEqual(reminderLines(dueReminders(list, "2026-08-13")), ["Birthday is due tomorrow (2026-08-14)."]);
  assert.deepEqual(reminderLines(dueReminders(list, "2026-08-14")), ["Birthday is due today (2026-08-14)."]);
}

// An inactive reminder is never due and never upcoming.
assert.equal(dueReminders([{ title: "x", freq: "daily", active: false }], "2026-08-05").length, 0);

// ===========================================================================
// 2026-08-06: the modifiers a real calendar needs. Everything above still
// passes unchanged, which is the point - these are additions, not a rewrite.
// ===========================================================================

// --- multi-weekday. Before this, Number([1,3,5]) was NaN and the rule silently
// returned no date at all: a Mon/Wed/Fri reminder that never fired and never
// said why.
assert.deepEqual(weekdayList({ weekdays: [5, 1, 3, 1] }), [1, 3, 5], "sorted, deduped");
assert.deepEqual(weekdayList({ weekday: [1, 5] }), [1, 5], "an array in the legacy scalar field still works");
assert.deepEqual(weekdayList({ weekday: 3 }), [3]);
assert.deepEqual(weekdayList({ weekdays: [9, -1, "x"] }), [], "garbage is dropped, not guessed at");

// A NULL weekday is absent, not Sunday. `Number(null)` is 0, and PostgREST hands
// back null for every unset column, so { freq: "weekly", weekday: null } - the
// shape of every weekly row read from the database - used to read as weekday 0:
// ruleProblem() said the rule was fine, the engine produced a run of Sundays,
// and describeRule() narrated the invention back as "every Sunday". Absent and
// null must answer identically or the validator is unreachable for the case that
// actually occurs.
assert.deepEqual(weekdayList({ weekday: null, weekdays: null }), [], "null is absent, not Sunday");
assert.deepEqual(weekdayList({ weekday: null, weekdays: null }), weekdayList({}), "null and absent answer the same");
assert.deepEqual(weekdayList({ weekday: "" }), [], "and an empty input value is not Sunday either");
assert.deepEqual(weekdayList({ weekday: 0 }), [0], "an EXPLICIT Sunday still means Sunday");
assert.deepEqual(weekdayList({ weekdays: null, weekday: 3 }), [3], "the DB shape: weekdays null, weekday set");
{
  const dbRow = { title: "Water the plants", freq: "weekly", weekday: null, weekdays: null,
    day_of_month: null, month_of_year: null, rule_interval: 1, max_count: null, dtstart: "2026-08-01", until: null };
  assert.match(ruleProblem(dbRow), /at least one weekday/, "the row must be REFUSED, in words");
  assert.equal(nextOccurrence(dbRow, "2026-08-06"), null);
  assert.deepEqual(occurrencesBetween(dbRow, "2026-08-06", "2026-09-05", 8), []);
  assert.equal(dueReminders([dbRow], "2026-08-09").length, 0, "and it must never reach the brief");
}
assert.deepEqual(
  occurrencesBetween({ freq: "weekly", weekdays: [1, 3, 5] }, "2026-08-03", "2026-08-10"),
  ["2026-08-03", "2026-08-05", "2026-08-07", "2026-08-10"],
);

// --- interval, anchored to dtstart. Unanchored it is unanswerable, so the
// engine refuses rather than guessing a phase off the day you happened to ask.
{
  const fortnightly = { freq: "weekly", weekday: 3, interval: 2, dtstart: "2026-08-05" };
  assert.equal(nextOccurrence(fortnightly, "2026-08-05"), "2026-08-05");
  assert.equal(nextOccurrence(fortnightly, "2026-08-06"), "2026-08-19", "skips the 12th - that is the off week");
  assert.deepEqual(
    occurrencesBetween(fortnightly, "2026-08-01", "2026-10-01"),
    ["2026-08-05", "2026-08-19", "2026-09-02", "2026-09-16", "2026-09-30"],
  );
  assert.equal(nextOccurrence({ freq: "weekly", weekday: 3, interval: 2 }, "2026-08-05"), null, "no anchor, no answer");
  assert.match(ruleProblem({ freq: "weekly", weekday: 3, interval: 2 }), /start date/);

  // Every 3 months from a specific month, and every 3 days.
  assert.deepEqual(
    occurrencesBetween({ freq: "monthly", day_of_month: 20, interval: 3, dtstart: "2026-05-20" }, "2026-01-01", "2027-06-30"),
    ["2026-05-20", "2026-08-20", "2026-11-20", "2027-02-20", "2027-05-20"],
  );
  assert.deepEqual(
    occurrencesBetween({ freq: "daily", interval: 3, dtstart: "2026-08-05" }, "2026-08-01", "2026-08-15"),
    ["2026-08-05", "2026-08-08", "2026-08-11", "2026-08-14"],
  );
  // Nothing fires before the series starts, whatever the caller asks from.
  assert.equal(nextOccurrence({ freq: "daily", dtstart: "2026-09-01" }, "2026-08-05"), "2026-09-01");
}

// --- nth weekday of the month: "the 3rd Tuesday", "the last Friday".
assert.equal(nthWeekdayOfMonth(2026, 8, 2, 3), "2026-08-18");
assert.equal(nthWeekdayOfMonth(2026, 8, 5, -1), "2026-08-28");
assert.equal(nthWeekdayOfMonth(2026, 8, 1, 5), "2026-08-31", "August 2026 does have a 5th Monday");
assert.equal(nthWeekdayOfMonth(2026, 8, 2, 5), null, "and no 5th Tuesday - null, not a guess");
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", nth_weekday: 3, weekday: 2 }, "2026-08-01", "2026-12-31"),
  ["2026-08-18", "2026-09-15", "2026-10-20", "2026-11-17", "2026-12-15"],
);
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", nth_weekday: -1, weekday: 5 }, "2026-08-01", "2026-12-31"),
  ["2026-08-28", "2026-09-25", "2026-10-30", "2026-11-27", "2026-12-25"],
);
assert.equal(describeRule({ freq: "monthly", nth_weekday: 3, weekday: 2 }), "the 3rd Tuesday of every month");
assert.equal(describeRule({ freq: "monthly", nth_weekday: -1, weekday: 5 }), "the last Friday of every month");

// --- until / count. COUNT sizes the RULE's set, so an EXDATE inside it still
// consumes one of the N (RFC 5545), and this engine does the same.
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", day_of_month: 1, until: "2026-11-01" }, "2026-08-01", "2027-06-30"),
  ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"],
);
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", day_of_month: 1, count: 3, dtstart: "2026-08-01" }, "2026-08-01", "2027-06-30"),
  ["2026-08-01", "2026-09-01", "2026-10-01"],
);
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", day_of_month: 1, count: 3, dtstart: "2026-08-01", exdates: ["2026-09-01"] }, "2026-08-01", "2027-06-30"),
  ["2026-08-01", "2026-10-01"],
  "the excluded date still used up one of the three",
);
assert.match(ruleProblem({ freq: "daily", count: 5 }), /count needs a start date/);
// max_count is the DB spelling of the same thing (`count` is a Postgres aggregate).
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", day_of_month: 1, max_count: 2, dtstart: "2026-08-01" }, "2026-08-01", "2027-06-30"),
  ["2026-08-01", "2026-09-01"],
);
// rule_interval likewise (`interval` is a Postgres type name).
assert.equal(nextOccurrence({ freq: "weekly", weekday: 3, rule_interval: 2, dtstart: "2026-08-05" }, "2026-08-06"), "2026-08-19");

// --- exdates and rdates. An RDATE is added to the set independently of COUNT
// and UNTIL: it is the user saying "and also this one", not part of the pattern.
assert.deepEqual(
  occurrencesBetween({ freq: "monthly", day_of_month: 1, exdates: ["2026-10-01"] }, "2026-08-01", "2026-12-31"),
  ["2026-08-01", "2026-09-01", "2026-11-01", "2026-12-01"],
);
assert.deepEqual(
  occurrencesBetween({ freq: "yearly", month_of_year: 8, day_of_month: 14, rdates: ["2026-09-02"] }, "2026-08-01", "2026-12-31"),
  ["2026-08-14", "2026-09-02"],
);
assert.deepEqual(
  occurrencesBetween({ freq: "yearly", month_of_year: 8, day_of_month: 14, rdates: ["2026-09-02"], exdates: ["2026-09-02"] }, "2026-08-01", "2026-12-31"),
  ["2026-08-14"],
  "an exdate beats an rdate for the same day",
);

// --- time of day.
assert.equal(minutesOfDay("18:30"), 1110);
assert.equal(minutesOfDay("18:30:00"), 1110, "a Postgres `time` column comes back with seconds");
assert.equal(minutesOfDay("9:05"), 545);
assert.equal(minutesOfDay("25:00"), null, "a time we cannot parse must not become midnight");
assert.equal(minutesOfDay(""), null);
assert.equal(minutesOfDay(null), null);
assert.equal(formatTime(1110), "18:30");
assert.equal(formatTime(545), "09:05");

// occurrenceKey is the identity of ONE firing - the string the server INSERTs to
// claim it. Without a time it is just the date key, so every row written before
// at_time existed keys exactly as it always did.
assert.equal(occurrenceKey({}, "2026-08-14", null), "2026-08-14");
assert.equal(occurrenceKey({ at_time: "18:30" }, "2026-08-14", null), "2026-08-14T18:30");
assert.equal(occurrenceKey({ at_time: "18:30:00" }, "2026-08-14", null), "2026-08-14T18:30", "normalised, so the two spellings claim the same slot");
assert.equal(occurrenceKey({ at_time: "9:05" }, "2026-08-14", null), "2026-08-14T09:05");
assert.equal(occurrenceKey({}, "2026-08-14", "07:00"), "2026-08-14T07:00", "an explicit time overrides the rule's");
assert.equal(occurrenceKey({}, "garbage", null), null);
// The zone is deliberately NOT in the key: moving zones does not turn "the 10th
// at 09:00" into a different occurrence, it only moves the instant.
assert.equal(
  occurrenceKey({ at_time: "18:30", timezone: "Asia/Kolkata" }, "2026-08-14", null),
  occurrenceKey({ at_time: "18:30", timezone: "Europe/London" }, "2026-08-14", null),
);

// timedDue: what the per-minute runner picks up.
{
  const timed = { id: "t", title: "Call mum", freq: "weekly", weekday: 3, at_time: "18:30" };
  const dateOnly = { id: "d", title: "Birthday", freq: "yearly", month_of_year: 8, day_of_month: 5 };
  assert.deepEqual(timedDue([timed, dateOnly], "2026-08-05", 1110).map((r) => r.id), ["t"],
    "a reminder with no at_time belongs to the 07:00 brief, not the minute runner");
  assert.deepEqual(timedDue([timed], "2026-08-05", 1109), [], "not before its time");
  assert.deepEqual(timedDue([timed], "2026-08-05", 1111).map((r) => r.occurrence_key), ["2026-08-05T18:30"]);
  assert.deepEqual(timedDue([timed], "2026-08-05", 1439), [], "and not four hours late either - the grace window is 3h");
  assert.deepEqual(timedDue([timed], "2026-08-06", 1110), [], "wrong day");
  assert.deepEqual(timedDue([{ ...timed, active: false }], "2026-08-05", 1110), []);
}

// Every due/upcoming row carries its claim key, so the brief, the minute runner
// and any on-device scheduler cannot disagree about WHICH firing they mean.
assert.equal(dueReminders([{ id: "a", title: "Rent", freq: "monthly", day_of_month: 5 }], "2026-08-05")[0].occurrence_key, "2026-08-05");
assert.equal(upcoming([{ id: "a", title: "Rent", freq: "monthly", day_of_month: 5, at_time: "10:00" }], "2026-08-05")[0].occurrence_key, "2026-08-05T10:00");

// --- the calendar's data shape.
{
  const rows = [
    { id: "a", title: "Standup", freq: "weekly", weekdays: [1, 3], at_time: "09:30" },
    { id: "b", title: "Birthday", freq: "yearly", month_of_year: 8, day_of_month: 5 },
    { id: "c", title: "Paused", freq: "daily", active: false },
  ];
  const byDay = agendaBetween(rows, "2026-08-03", "2026-08-10");
  assert.deepEqual(Object.keys(byDay).sort(), ["2026-08-03", "2026-08-05", "2026-08-10"]);
  assert.deepEqual(byDay["2026-08-05"].map((r) => r.id), ["a", "b"], "timed first, then untimed alphabetically");
  assert.equal(byDay["2026-08-05"][0].occurrence_key, "2026-08-05T09:30");
  assert.ok(!Object.values(byDay).flat().some((r) => r.id === "c"), "a paused rule is on no day");
}

// --- ruleProblem says WHY, in words. A rule that is stored, never fires, and
// never explains itself is the exact failure this codebase keeps rediscovering.
assert.equal(ruleProblem({ freq: "yearly", month_of_year: 8, day_of_month: 14 }), null);
assert.match(ruleProblem({ freq: "nope" }), /unknown frequency/);
assert.match(ruleProblem({ freq: "once" }), /needs a date/);
assert.match(ruleProblem({ freq: "weekly" }), /at least one weekday/);
assert.match(ruleProblem({ freq: "monthly" }), /day of the month/);
assert.match(ruleProblem({ freq: "yearly", day_of_month: 14 }), /anchor month/);
assert.match(ruleProblem({ freq: "monthly", nth_weekday: 9, weekday: 1 }), /1\.\.5/);
assert.match(ruleProblem({ freq: "monthly", nth_weekday: 3 }), /needs a weekday/);
assert.match(ruleProblem({ freq: "daily", at_time: "half past six" }), /HH:MM/);
assert.match(ruleProblem({ freq: "daily", until: "next year" }), /until must be/);
assert.match(ruleProblem({ freq: "daily", dtstart: "soon" }), /dtstart must be/);

// --- weekIndex is Sunday-based, matching weekdayOf.
assert.equal(weekIndex("2026-08-05") - weekIndex("2026-07-29"), 1, "one week apart");
assert.equal(weekIndex("2026-08-02"), weekIndex("2026-08-08"), "Sunday to Saturday is one week");

// --- phrasing, with the modifiers on.
assert.equal(describeRule({ freq: "weekly", weekdays: [1, 3], interval: 2, dtstart: "2026-08-03" }), "Monday, Wednesday, every 2nd week");
assert.equal(describeRule({ freq: "daily", interval: 3, dtstart: "2026-08-05" }), "every 3 days");
assert.equal(describeRule({ freq: "monthly", day_of_month: 5, at_time: "18:30" }), "the 5th of every month at 18:30");
assert.equal(describeRule({ freq: "monthly", day_of_month: 1, count: 3, dtstart: "2026-08-01" }), "the 1st of every month, 3 times");
assert.equal(describeRule({ freq: "monthly", day_of_month: 1, until: "2026-11-01" }), "the 1st of every month, until 2026-11-01");
assert.equal(describeRule({ freq: "monthly", day_of_month: 1, exdates: ["2026-10-01"] }), "the 1st of every month, except 2026-10-01");
assert.equal(reminderLines(dueReminders([{ title: "Call mum", freq: "daily", at_time: "18:30" }], "2026-08-05"))[0],
  "Call mum is due today at 18:30 (2026-08-05).");

console.log("reminders tests passed");
