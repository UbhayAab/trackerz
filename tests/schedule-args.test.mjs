// The sentence-to-calendar-row layer, and the one thing it must never do:
// silently drop a modifier it was given.
//
// Every assertion below is a phrasing the agent could previously only store as
// a plain rule. "every other Wednesday at 18:30" was a weekly rule with no hour
// and no phase - so it fired on the wrong week at the wrong time and reported
// success. These tests fail if any modifier stops reaching a column.

import assert from "node:assert/strict";
import {
  hhmm, clampInt, isDateKey, NTH_WEEKDAY_RE, SCHEDULE_CUE, parseNthWeekday, SA_MAX_COUNT,
  saAddDays, saWeekdayOf, saDayKey, saMinuteOfDay, zonedToUtcIso,
  reminderColumns, firstFireKey, taskRow,
} from "../lib/schedule-args.mjs";
import { dayKeyInTz, minuteOfDayInTz, addDays as tzAddDays, weekdayInTz } from "../lib/tz.mjs";
import { nextOccurrence, ruleProblem } from "../lib/reminders.mjs";

const IST = "Asia/Kolkata";

// ---- hhmm ----
assert.equal(hhmm("18:30"), "18:30");
assert.equal(hhmm("6:30 pm"), "18:30");
assert.equal(hhmm("6pm"), "18:00");
assert.equal(hhmm("12am"), "00:00");
assert.equal(hhmm("12pm"), "12:00");
assert.equal(hhmm("0930"), "09:30");
assert.equal(hhmm("9"), "09:00");
// A bad time must be NULL, never a guess. "quarter past six" with no digits is
// not 06:00 - a reminder that fires at a made-up hour is worse than one with no
// hour at all, because the no-hour case rides the morning brief and is seen.
assert.equal(hhmm("quarter past six"), null);
assert.equal(hhmm("25:00"), null);
assert.equal(hhmm("18:75"), null);
assert.equal(hhmm(""), null);
assert.equal(hhmm(null), null);

// ---- clampInt: out of range is null, NOT clamped to the bound ----
assert.equal(clampInt(3, 1, 52), 3);
assert.equal(clampInt("3", 1, 52), 3);
assert.equal(clampInt(99, 1, 52), null, "99 must not become 52");
assert.equal(clampInt(0, 1, 52), null);
assert.equal(clampInt(NaN, 1, 52), null);
assert.equal(clampInt(undefined, 0, 6), null);
assert.equal(clampInt(0, 0, 6), 0, "0 is a valid weekday and must survive");

// ---- isDateKey checks the calendar, not the shape ----
assert.equal(isDateKey("2026-08-06"), true);
assert.equal(isDateKey("2026-02-30"), false);
assert.equal(isDateKey("2026-13-01"), false);
assert.equal(isDateKey("2024-02-29"), true);
assert.equal(isDateKey("2026-8-6"), false);

// ---- nth weekday ----
for (const ok of ["3TU", "-1FR", "1SU", "5SA"]) assert.ok(NTH_WEEKDAY_RE.test(ok), ok);
for (const bad of ["6MO", "0TU", "3XX", "TU", "-6FR"]) assert.ok(!NTH_WEEKDAY_RE.test(bad), bad);

// Both forms in, one shape out.
assert.deepEqual(parseNthWeekday("3TU"), { nth: 3, weekday: 2 });
assert.deepEqual(parseNthWeekday("-1fr"), { nth: -1, weekday: 5 });
assert.deepEqual(parseNthWeekday(3), { nth: 3, weekday: null }, "a bare int keeps the separate weekday field");
assert.deepEqual(parseNthWeekday("-1"), { nth: -1, weekday: null });
assert.deepEqual(parseNthWeekday(0), { nth: null, weekday: null }, "0 is not an ordinal");
assert.deepEqual(parseNthWeekday(9), { nth: null, weekday: null });
assert.deepEqual(parseNthWeekday("9ZZ"), { nth: null, weekday: null });
assert.deepEqual(parseNthWeekday(null), { nth: null, weekday: null });
// An explicit weekday outranks the one implied by the ordinal string.
assert.equal(reminderColumns({ title: "X", freq: "monthly", nth_weekday: "1MO", weekday: 4 }, { today: "2026-08-06" }).weekday, 4);

// ---- the duplicated day-key helpers agree with lib/tz.mjs ----
// This is the whole justification for having a second copy inside the mirror.
{
  let key = "2026-01-01";
  for (let i = 0; i < 400; i++) {
    assert.equal(saAddDays(key, 1), tzAddDays(key, 1), `addDays diverged at ${key}`);
    key = saAddDays(key, 1);
  }
  // Instants across a whole year, including the 18:30 UTC boundary that flips
  // the IST day - the exact bug lib/tz.mjs was written to kill.
  for (let d = 0; d < 365; d += 7) {
    for (const h of [0, 12, 18, 19, 23]) {
      const iso = new Date(Date.UTC(2026, 0, 1 + d, h, 45)).toISOString();
      assert.equal(saDayKey(iso, IST), dayKeyInTz(iso, IST), `dayKey diverged at ${iso}`);
      assert.equal(saMinuteOfDay(iso, IST), minuteOfDayInTz(iso, IST), `minute diverged at ${iso}`);
      assert.equal(saWeekdayOf(saDayKey(iso, IST)), weekdayInTz(iso, IST), `weekday diverged at ${iso}`);
    }
  }
}

// ---- zonedToUtcIso ----
// 18:30 IST is 13:00 UTC. India has no DST, so this is exact all year.
assert.equal(zonedToUtcIso("2026-08-06", "18:30", IST), "2026-08-06T13:00:00.000Z");
assert.equal(zonedToUtcIso("2026-01-15", "18:30", IST), "2026-01-15T13:00:00.000Z");
// A zone that DOES observe DST: 09:00 New York is 13:00 UTC in summer, 14:00 in
// winter. If the two-pass offset were wrong this would be off by an hour.
assert.equal(zonedToUtcIso("2026-07-15", "09:00", "America/New_York"), "2026-07-15T13:00:00.000Z");
assert.equal(zonedToUtcIso("2026-01-15", "09:00", "America/New_York"), "2026-01-15T14:00:00.000Z");
// Round trip: the instant we compute must read back as the wall time we asked for.
for (const t of ["00:00", "06:15", "13:45", "23:59"]) {
  const iso = zonedToUtcIso("2026-08-06", t, IST);
  assert.equal(saDayKey(iso, IST), "2026-08-06", `${t} landed on the wrong day`);
  assert.equal(saMinuteOfDay(iso, IST), Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), t);
}

// ---- reminderColumns: every modifier reaches a column ----
const TODAY = "2026-08-06"; // a Thursday

{
  // "every other Wednesday at 18:30" - the sentence in the handoff note.
  const r = reminderColumns(
    { title: "Standup", freq: "weekly", weekday: 3, interval: 2, at_time: "18:30" },
    { today: TODAY, tz: IST },
  );
  assert.equal(r.freq, "weekly");
  assert.equal(r.weekday, 3);
  assert.equal(r.rule_interval, 2, "interval must not be dropped");
  assert.equal(r.at_time, "18:30", "the hour must not be dropped");
  assert.equal(r.dtstart, TODAY, "an interval rule with no anchor must be anchored to today");
  assert.equal(r.timezone, IST);
  // And the engine that will actually fire it accepts the row unmodified.
  assert.equal(ruleProblem(r), null, "the engine must consider the written row valid");
}

{
  // "last Friday of every month at 4pm, until December"
  const r = reminderColumns(
    { title: "Review", freq: "monthly", nth_weekday: "-1fr", at_time: "4pm", until: "2026-12-31" },
    { today: TODAY, tz: IST },
  );
  // The RFC string is split into the two integers the int column and the engine
  // actually use. Sending "-1FR" through would have failed the insert on a type
  // error, and the weekday would have been lost.
  assert.equal(r.nth_weekday, -1);
  assert.equal(r.weekday, 5, "the FR in -1FR must land in the weekday column");
  assert.equal(r.at_time, "16:00");
  assert.equal(r.until, "2026-12-31");
  assert.equal(ruleProblem(r), null);
  const next = nextOccurrence(r, TODAY);
  assert.equal(next, "2026-08-28", `last Friday of Aug 2026 is the 28th, got ${next}`);
}

{
  // "Mon, Wed and Fri" - the multi-weekday list.
  const r = reminderColumns({ title: "Gym", freq: "weekly", weekdays: [1, 3, 5] }, { today: TODAY, tz: IST });
  assert.deepEqual(r.weekdays, [1, 3, 5]);
  assert.equal(nextOccurrence(r, TODAY), "2026-08-07", "next after Thu is Fri");
}

{
  // "the next 6 Mondays"
  const r = reminderColumns({ title: "Class", freq: "weekly", weekday: 1, count: 6 }, { today: TODAY, tz: IST });
  assert.equal(r.max_count, 6);
}

{
  // Garbage modifiers must be dropped to null, never coerced into a bound.
  const r = reminderColumns(
    { title: "X", freq: "weekly", interval: 999, weekday: 12, at_time: "banana", until: "soon", nth_weekday: "9ZZ", count: -3 },
    { today: TODAY, tz: IST },
  );
  assert.equal(r.rule_interval ?? null, null);
  assert.equal(r.weekday ?? null, null);
  assert.equal(r.at_time ?? null, null);
  assert.equal(r.until ?? null, null);
  assert.equal(r.nth_weekday ?? null, null);
  assert.equal(r.max_count ?? null, null);
}

// lead_days still defaults by kind, and an explicit 0 survives.
assert.equal(reminderColumns({ title: "GST", freq: "monthly", kind: "filing" }, { today: TODAY }).lead_days, 7);
assert.equal(reminderColumns({ title: "Bday", freq: "yearly", kind: "birthday" }, { today: TODAY }).lead_days, 2);
assert.equal(reminderColumns({ title: "X", freq: "daily" }, { today: TODAY }).lead_days, 0);
assert.equal(reminderColumns({ title: "X", freq: "daily", kind: "filing", lead_days: 0 }, { today: TODAY }).lead_days, 0);

// ---- NO KEY IS EVER null, because these are INSERT payloads ----
// reminders.rule_interval is NOT NULL DEFAULT 1. An explicit null OVERRIDES the
// default and violates the constraint, so every reminder the agent wrote failed -
// silently, because PostgREST returns { data: null, error } rather than throwing,
// and the caller read "no row" as "demote to proposed" and dropped the reason.
// The owner saw a growing list of unexplained pending items and no reminders.
{
  const shapes = [
    { title: "A", freq: "once" },
    { title: "B", freq: "weekly", weekday: 1 },
    { title: "C", freq: "monthly", day_of_month: 5, interval: 3 },
    { title: "D", freq: "yearly", month_of_year: 10, day_of_month: 19, at_time: "09:00" },
    { title: "E", freq: "weekly", weekdays: [1, 3], count: 6, until: "2026-12-31" },
  ];
  for (const shape of shapes) {
    const row = reminderColumns(shape, { today: TODAY, tz: IST });
    for (const [k, v] of Object.entries(row)) {
      assert.notEqual(v, null, `reminderColumns emitted an explicit null for "${k}" - omit the key instead`);
    }
  }
  const t = taskRow({ prompt: "x" }, { today: TODAY, tz: IST });
  for (const [k, v] of Object.entries(t)) {
    assert.notEqual(v, null, `taskRow emitted an explicit null for "${k}" - omit the key instead`);
  }
}

// ---- firstFireKey ----
assert.equal(firstFireKey({ on_date: "2026-09-01" }, TODAY), "2026-09-01");
assert.equal(firstFireKey({ freq: "weekly", weekday: 5 }, TODAY), "2026-08-07", "Fri after Thu");
assert.equal(firstFireKey({ freq: "weekly", weekday: 4 }, TODAY), TODAY, "today counts as the first fire");
assert.equal(firstFireKey({ freq: "weekly", weekdays: [0, 6] }, TODAY), "2026-08-08", "Sat before Sun");
assert.equal(firstFireKey({ freq: "monthly", day_of_month: 1 }, TODAY), "2026-09-01");
assert.equal(firstFireKey({ freq: "monthly", day_of_month: 31 }, TODAY), "2026-08-31");
// A day-of-month that does not exist next month still finds a real one later,
// rather than silently returning today.
assert.equal(firstFireKey({ freq: "monthly", day_of_month: 30 }, "2026-01-31"), "2026-03-30");
assert.equal(firstFireKey({ freq: "daily" }, TODAY), TODAY);

// ---- taskRow ----
{
  // "check at 3pm" said at 16:00 must be TOMORROW at 3pm, not three seconds ago.
  const t = taskRow({ prompt: "check protein", at_time: "15:00" }, { today: TODAY, nowMinutes: 16 * 60, tz: IST });
  assert.equal(saDayKey(t.fire_at, IST), "2026-08-07", "a passed hour rolls to tomorrow");
  assert.equal(saMinuteOfDay(t.fire_at, IST), 15 * 60);
  assert.equal(t.recurrence ?? null, null, "a one-shot has no recurrence - the key is omitted so the column default applies");
  assert.equal(t.intent, "check");
}
{
  // The same time said at 09:00 fires today.
  const t = taskRow({ prompt: "check protein", at_time: "15:00" }, { today: TODAY, nowMinutes: 9 * 60, tz: IST });
  assert.equal(saDayKey(t.fire_at, IST), TODAY);
}
{
  // An EXPLICIT day is never rolled forward, even if its hour has passed - the
  // user named the day, so honouring the hour and moving the day would be the
  // app overruling a direct instruction.
  const t = taskRow({ prompt: "x", on_date: TODAY, at_time: "09:00" }, { today: TODAY, nowMinutes: 22 * 60, tz: IST });
  assert.equal(saDayKey(t.fire_at, IST), TODAY);
}
{
  // "every Sunday night review my spending"
  const t = taskRow(
    { prompt: "Review this week's spending.", intent: "review", freq: "weekly", weekday: 0, at_time: "21:00" },
    { today: TODAY, nowMinutes: 10 * 60, tz: IST },
  );
  assert.equal(t.intent, "review");
  assert.equal(saDayKey(t.fire_at, IST), "2026-08-09", "the next Sunday");
  assert.equal(saMinuteOfDay(t.fire_at, IST), 21 * 60);
  assert.equal(t.recurrence.freq, "weekly");
  assert.equal(t.recurrence.weekday, 0);
  assert.equal(t.recurrence.at_time, "21:00");
  assert.equal(t.recurrence.dtstart, "2026-08-09", "the recurrence is anchored to the first fire");
  // The re-arm engine must accept the recurrence this writes.
  assert.equal(ruleProblem(t.recurrence), null);
  // nextOccurrence is inclusive of `from`, so ask from the day AFTER the first
  // fire to see the second one.
  assert.equal(nextOccurrence(t.recurrence, "2026-08-09"), "2026-08-09");
  assert.equal(nextOccurrence(t.recurrence, "2026-08-10"), "2026-08-16");
}
{
  // An unknown intent falls back to "check", never to a DB constraint violation.
  assert.equal(taskRow({ prompt: "x", intent: "nuke" }, { today: TODAY }).intent, "check");
  assert.equal(taskRow({ prompt: "x" }, { today: TODAY }).intent, "check");
}
{
  // No hour at all defaults to a civilised one rather than midnight.
  const t = taskRow({ prompt: "x" }, { today: TODAY, nowMinutes: 3 * 60, tz: IST });
  assert.equal(saMinuteOfDay(t.fire_at, IST), 9 * 60);
}

// ---- the COUNT ceiling matches the database, or writes die on a constraint ----
// This clamp said 500 while reminders_max_count_check allowed 400, so count 450
// passed validation here and then failed the INSERT. A validator that accepts
// what the next layer rejects moves the failure somewhere nobody reads.
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const sql = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8")).join("\n");
  // Both spellings, because the migration says `between 1 and 400` and a later
  // one could just as easily say `<= 400`. A guard that only knows one dialect
  // fails on a rewrite that changed nothing.
  const m = sql.match(/reminders_max_count_check[\s\S]{0,300}?max_count\s*(?:between\s*\d+\s*and\s*|<=\s*)(\d+)/i);
  assert.ok(m, "could not find the max_count check constraint in any migration");
  assert.equal(SA_MAX_COUNT, Number(m[1]),
    `the clamp (${SA_MAX_COUNT}) and the database check (${m[1]}) disagree - a capture in between passes here and dies on the INSERT`);
  assert.equal(reminderColumns({ title: "X", freq: "weekly", weekday: 1, count: SA_MAX_COUNT + 1 }, { today: TODAY }).max_count ?? null, null,
    "a count past the database limit must be dropped, not written through to fail the insert");
  assert.equal(reminderColumns({ title: "X", freq: "weekly", weekday: 1, count: SA_MAX_COUNT }, { today: TODAY }).max_count, SA_MAX_COUNT);
}

// ---- SCHEDULE_CUE: grounding for a prompt the model wrote itself ----
for (const yes of [
  "check on Friday whether I hit my protein goal",
  "remind me every Monday",
  "schedule a weekly review",
  "tell me tomorrow if I am behind",
  "at 3pm let me know about water",
  "every other wednesday standup",
  "each week look at my spending",
  "end of the month check my budget",
]) assert.ok(SCHEDULE_CUE.test(yes), `should be a schedule cue: ${yes}`);

for (const no of [
  "6 boiled eggs and 500ml curd",
  "went to the gym today",
  "spent 250 on lunch",
  "my diet has changed, I now have 2 scoops of whey",
  "how much protein did I eat",
]) assert.ok(!SCHEDULE_CUE.test(no), `should NOT be a schedule cue: ${no}`);

console.log("schedule-args tests passed: modifiers reach columns, helpers agree with lib/tz.mjs, passed hours roll forward");
