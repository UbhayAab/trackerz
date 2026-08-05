import assert from "node:assert/strict";
import {
  nextOccurrence, occurrencesBetween, describeRule, dueReminders, upcoming,
  whenLabel, reminderLines, weekdayOf, addDays, daysBetween, clampDay, isLeapYear, daysInMonth,
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

console.log("reminders tests passed");
