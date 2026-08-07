// CALENDAR UI - the pure render helpers behind src/ui/calendar-panel.js.
//
// Headless, plain Node, no DOM - the house pattern (tests/diff-card.test.mjs,
// tests/ui-contract.test.mjs). Everything asserted here is a function that takes
// rules and a date key and returns a string or a plain object, which is why the
// calendar can be tested at all: the DOM half is nine lines of addEventListener
// at the bottom of the module and nothing else.
//
// What this file is really guarding:
//   - a FAILED read never renders as an empty calendar;
//   - an item with no at_time is never drawn on the hour rail;
//   - two items at the same hour do not draw on top of each other;
//   - the month grid is keyboard-navigable and the arrow keys land on real days;
//   - nothing user-supplied reaches the page unescaped.

import assert from "node:assert/strict";
import {
  monthCells, monthLabel, stepMonth, stepFocus, weekKeys, weekLabel,
  timeWindow, laneLayout, dayHeading, longDayHeading, daySummary, dayItems,
  renderAgenda, renderWeek, renderMonth, renderDayDetail, renderTaskRuns,
  renderCalendar, calendarStatus, initialCalendarState, countUpcoming,
  runStamp, awayLabel, escapeHtml, KIND_ICON, RUN_ICON, VIEWS,
} from "../src/ui/calendar-panel.js";

const TODAY = "2026-08-06"; // a Thursday

// A rule set with one of everything the engine can express.
const RULES = () => [
  { id: "r1", title: "Rent", kind: "bill", freq: "monthly", day_of_month: 5, at_time: "05:00" },
  { id: "r2", title: "Birthday", kind: "birthday", freq: "yearly", month_of_year: 8, day_of_month: 14 },
  { id: "r3", title: "Call mum", kind: "appointment", freq: "weekly", weekdays: [4], at_time: "18:30" },
  { id: "r4", title: "Gym check", kind: "appointment", freq: "weekly", weekdays: [4], at_time: "18:45" },
];
const TASK = {
  id: "task:t1", task_id: "t1", title: "Review my spending", kind: "agent", is_task: true,
  intent: "review", freq: "weekly", weekdays: [0], at_time: "20:30", active: true,
};

// ---- date maths ------------------------------------------------------------

{
  assert.equal(dayHeading(TODAY, TODAY), "Today");
  assert.equal(dayHeading("2026-08-07", TODAY), "Tomorrow");
  assert.equal(dayHeading("2026-08-14", TODAY), "Fri 14 Aug");
  assert.equal(longDayHeading("2026-08-14"), "Friday 14 August 2026");
  assert.equal(monthLabel(2026, 8), "August 2026");
  assert.deepEqual(stepMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(stepMonth(2026, 1, -1), { year: 2025, month: 12 });
}

// A calendar you can page BACKWARDS through will hand the label a negative, and
// lib's whenLabel() - written for "due in 3 days" - renders that as "in -4 days".
// Opening last Sunday has to read as English.
{
  assert.equal(awayLabel(TODAY, TODAY), "today");
  assert.equal(awayLabel(TODAY, "2026-08-07"), "tomorrow");
  assert.equal(awayLabel(TODAY, "2026-08-09"), "in 3 days");
  assert.equal(awayLabel(TODAY, "2026-08-05"), "yesterday");
  assert.equal(awayLabel(TODAY, "2026-08-02"), "4 days ago");
  assert.equal(awayLabel(TODAY, "2026-07-06"), "4 weeks ago");
  assert.equal(awayLabel(TODAY, "2026-02-06"), "6 months ago");
  assert.equal(awayLabel(TODAY, "nonsense"), "");
}

// weekKeys is Sunday-first, matching weekdayOf(), so a date sits in the same
// column in the week view and the month grid.
{
  const keys = weekKeys(TODAY);
  assert.equal(keys.length, 7);
  assert.equal(keys[0], "2026-08-02", "the week containing Thu 6 Aug starts Sun 2 Aug");
  assert.equal(keys[6], "2026-08-08");
  assert.ok(keys.includes(TODAY));
  assert.equal(weekLabel(keys), "2 - 8 Aug");
  assert.equal(weekLabel(weekKeys("2026-08-01")), "26 Jul - 1 Aug", "a week across two months names both");
  assert.equal(weekLabel(weekKeys("2027-01-01")), "27 Dec 2026 - 2 Jan 2027", "and across two years, both years");
}

// ---- keyboard movement -----------------------------------------------------

{
  assert.equal(stepFocus("2026-08-06", "left"), "2026-08-05");
  assert.equal(stepFocus("2026-08-06", "right"), "2026-08-07");
  assert.equal(stepFocus("2026-08-06", "up"), "2026-07-30");
  assert.equal(stepFocus("2026-08-06", "down"), "2026-08-13");
  assert.equal(stepFocus("2026-08-06", "weekStart"), "2026-08-02");
  assert.equal(stepFocus("2026-08-06", "weekEnd"), "2026-08-08");
  // Arrowing off the end of a month lands on the next month, not nowhere.
  assert.equal(stepFocus("2026-08-31", "right"), "2026-09-01");
  assert.equal(stepFocus("2026-08-01", "left"), "2026-07-31");
  // Paging by month CLAMPS the day rather than rolling it - 31 March back one
  // month is 28 February, the same rule the recurrence engine uses. Rolling to
  // 3 March would move a date past itself.
  assert.equal(stepFocus("2026-03-31", "prevMonth"), "2026-02-28");
  assert.equal(stepFocus("2024-03-31", "prevMonth"), "2024-02-29", "and 29 Feb in a leap year");
  assert.equal(stepFocus("2026-01-31", "nextMonth"), "2026-02-28");
  assert.equal(stepFocus("garbage", "left"), "garbage", "an unparseable key is survivable");
  assert.equal(stepFocus("2026-08-06", "nonsense"), "2026-08-06", "an unknown action moves nothing");
}

// ---- monthCells ------------------------------------------------------------

{
  const marks = {
    "2026-08-05": [{ kind: "bill", at_time: "05:00" }],
    "2026-08-14": [{ kind: "birthday" }, { kind: "bill", at_time: "09:00" }],
  };
  const cells = monthCells(2026, 8, { marks, today: TODAY });
  assert.equal(cells.length, 42, "always six rows, so the grid never resizes under the finger");
  // 1 Aug 2026 is a Saturday -> six leading blanks.
  assert.equal(cells.filter((c) => !c.inMonth).length, 42 - 31);
  assert.equal(cells[6].key, "2026-08-01");
  const today = cells.find((c) => c.key === TODAY);
  assert.equal(today.isToday, true);
  assert.equal(today.isPast, false);
  assert.equal(cells.find((c) => c.key === "2026-08-05").isPast, true);
  // Timed and all-day are counted apart, because the cell marks them with
  // different SHAPES rather than different colours.
  const b = cells.find((c) => c.key === "2026-08-14");
  assert.equal(b.count, 2);
  assert.equal(b.timed, 1);
  assert.equal(b.allDay, 1);
  assert.deepEqual(b.kinds, ["birthday", "bill"]);
  // February in a leap year, and the blanks that pad it.
  assert.equal(monthCells(2024, 2, {}).filter((c) => c.inMonth).length, 29);
  assert.equal(monthCells(2026, 2, {}).filter((c) => c.inMonth).length, 28);
}

// ---- the hour window -------------------------------------------------------

{
  const byDay = {
    "2026-08-06": [{ at_time: "18:30" }, { at_time: "18:45" }],
    "2026-08-08": [{ at_time: "09:15" }],
  };
  const keys = weekKeys(TODAY);
  const win = timeWindow(byDay, keys);
  assert.equal(win.hasTimed, true);
  assert.equal(win.startMin, 8 * 60, "09:15 padded an hour and floored to the hour");
  assert.equal(win.endMin, 20 * 60, "18:45 padded an hour and ceiled to the hour");
}
{
  // Nothing timed at all: a default window, and a flag saying not to draw it.
  // An axis over seven empty rails is furniture.
  const win = timeWindow({}, weekKeys(TODAY));
  assert.equal(win.hasTimed, false);
  assert.equal(win.startMin, 8 * 60);
  assert.equal(win.endMin, 20 * 60);
}
{
  // One event would otherwise get a two-hour axis, on which 18:30 and 18:45 look
  // like opposite ends of the day.
  const win = timeWindow({ d: [{ at_time: "12:00" }] }, ["d"]);
  assert.ok(win.endMin - win.startMin >= 180, `window ${win.startMin}-${win.endMin} is at least three hours`);
}
{
  // Clamped to the real day at both ends - there is no 25:00.
  const win = timeWindow({ d: [{ at_time: "00:05" }, { at_time: "23:55" }] }, ["d"]);
  assert.equal(win.startMin, 0);
  assert.equal(win.endMin, 1440);
}

// ---- laneLayout: the all-day split and overlap resolution ------------------

{
  const items = [
    { title: "Birthday", kind: "birthday" },                    // no at_time
    { title: "Call mum", kind: "appointment", at_time: "18:30" },
    { title: "Gym check", kind: "appointment", at_time: "18:45" },
    { title: "Rent", kind: "bill", at_time: "05:00:00" },        // Postgres time form
  ];
  const out = laneLayout(items, { startMin: 4 * 60, endMin: 20 * 60, minSpanMin: 45 });

  // THE RULE THIS FILE EXISTS FOR: a reminder with no time is never placed on
  // the rail. Rendering it at midnight would be a fabricated fact.
  assert.equal(out.allDay.length, 1);
  assert.equal(out.allDay[0].title, "Birthday");
  assert.equal(out.blocks.length, 3, "only the timed ones get blocks");
  assert.ok(out.blocks.every((b) => b.item.title !== "Birthday"));

  // Sorted by time, not by input order.
  assert.deepEqual(out.blocks.map((b) => b.item.title), ["Rent", "Call mum", "Gym check"]);

  // 05:00 in a 04:00-20:00 window is one hour into sixteen.
  const rent = out.blocks[0];
  assert.equal(rent.atMin, 300);
  assert.ok(Math.abs(rent.leftPct - (60 / 960) * 100) < 0.001);
  assert.ok(Math.abs(rent.widthPct - (45 / 960) * 100) < 0.001);
  assert.equal(rent.lane, 0);
  assert.equal(rent.clipped, false);

  // 18:30 and 18:45 are 15 minutes apart with a 45-minute nominal width, so they
  // WOULD draw on top of each other. Second one goes down a lane; neither moves
  // sideways, because sliding an event to a tidier slot lies about when it is.
  const [mum, gym] = [out.blocks[1], out.blocks[2]];
  assert.equal(mum.lane, 0);
  assert.equal(gym.lane, 1);
  assert.ok(gym.leftPct > mum.leftPct, "the later one is still drawn later");
  assert.equal(out.lanes, 2, "the row grows to two lanes");
}
{
  // Far enough apart to share a lane - lanes are for collisions, not for count.
  const out = laneLayout([{ title: "a", at_time: "09:00" }, { title: "b", at_time: "15:00" }],
    { startMin: 8 * 60, endMin: 18 * 60, minSpanMin: 45 });
  assert.deepEqual(out.blocks.map((b) => b.lane), [0, 0]);
  assert.equal(out.lanes, 1);
}
{
  // Three at the same minute is three lanes, and a stable order.
  const out = laneLayout(
    [{ title: "c", at_time: "10:00" }, { title: "a", at_time: "10:00" }, { title: "b", at_time: "10:00" }],
    { startMin: 9 * 60, endMin: 12 * 60 },
  );
  assert.deepEqual(out.blocks.map((b) => b.item.title), ["a", "b", "c"], "ties break on title");
  assert.deepEqual(out.blocks.map((b) => b.lane), [0, 1, 2]);
}
{
  // Outside the window: pinned to the edge and MARKED, never silently relocated.
  const out = laneLayout([{ title: "late", at_time: "23:30" }], { startMin: 8 * 60, endMin: 20 * 60 });
  assert.equal(out.blocks[0].clipped, true);
  assert.equal(out.blocks[0].atMin, 1410, "the true minute survives the clamp");
  assert.ok(out.blocks[0].leftPct <= 100);
  assert.ok(out.blocks[0].leftPct + out.blocks[0].widthPct <= 100.001, "nothing is drawn past the rail");
}
{
  // A time the engine refuses to parse is NOT quietly turned into midnight.
  const out = laneLayout([{ title: "bad", at_time: "25:99" }, { title: "empty", at_time: "" }], {});
  assert.equal(out.blocks.length, 0);
  assert.equal(out.allDay.length, 2);
}
assert.deepEqual(laneLayout(null, {}).blocks, [], "nulls are survivable");

// ---- daySummary ------------------------------------------------------------

{
  assert.equal(daySummary([]), "nothing scheduled");
  assert.equal(daySummary([{ title: "x" }]), "1 item, no set time");
  assert.equal(daySummary([{ title: "x", at_time: "18:30" }, { title: "y" }]), "2 items, first at 18:30");
  assert.equal(daySummary([{ at_time: "18:30" }, { at_time: "09:00" }]), "2 items, first at 09:00");
}

// ---- the agenda ------------------------------------------------------------

{
  const html = renderAgenda(RULES(), TODAY);
  assert.ok(html.includes("Today"), "today is named, not dated");
  assert.ok(html.includes("Call mum"));
  assert.ok(html.includes("18:30"));
  // The day heading is a BUTTON, because tapping it is how you open the day.
  assert.ok(/<button type="button" class="cal-agenda-head" data-day="2026-08-06"/.test(html));
  assert.ok(html.includes('aria-expanded="false"'));
  // Every item carries its glyph. (Rent is on the 5th, so it falls outside the
  // 21-day window from 6 Aug - the agenda is what is COMING, not everything.)
  assert.ok(html.includes(KIND_ICON.appointment));
  assert.ok(html.includes(KIND_ICON.birthday));
  assert.ok(!html.includes("Rent"));
  // A no-time item SAYS it has no time rather than leaving a gap.
  assert.ok(html.includes("All day"));
  assert.ok(!/<table/i.test(html), "never a table at 320px");
}
{
  // THE EMPTY-VIEWS REGRESSION, 2026-08-08. The owner's live calendar held two
  // rules, 63 and 72 days out, and agenda / week / month were ALL blank at once
  // ("what is this calendar view dude, it's so empty"). A sentence naming the
  // next date is not a calendar: an empty near window must REACH AHEAD and draw
  // the real rows, and say that it did.
  const far = [{ id: "f", title: "Diwali", kind: "other", freq: "yearly", month_of_year: 11, day_of_month: 8 }];
  const html = renderAgenda(far, TODAY);
  assert.ok(html.includes("Nothing in the next 21 days, so this reaches ahead to Sun 8 Nov"));
  assert.ok(html.includes("Diwali"), "and the far item is DRAWN, not merely named");
  assert.ok(html.includes('data-day="2026-11-08"'), "as a real, openable day");
  assert.ok(html.includes("cal-agenda-items"), "with the agenda's own markup");
}
{
  // Nothing at all, ever: no invented "next", and no claim about 21 days when it
  // looked much further than that.
  const html = renderAgenda([], TODAY);
  assert.ok(html.includes("Nothing scheduled, now or ahead"));
  assert.ok(!html.includes("Next is"));
  assert.ok(!html.includes("cal-widened"), "nothing was widened, because there was nothing to widen to");
}
{
  // More days than fit are counted, not dropped.
  const daily = [{ id: "d", title: "Water", kind: "other", freq: "daily" }];
  const html = renderAgenda(daily, TODAY);
  assert.ok(/1[34] more days ahead\./.test(html), html.slice(-120));
  assert.ok(!html.includes("Nothing else until"), "a truncated agenda counts, it does not look past the window");
  assert.ok(!html.includes("cal-widened"), "a full near window is never widened");
}
{
  // The owner's real shape: one thing inside the window, the next one two months
  // out. An agenda that stops at the window edge reads as "and then nothing".
  const real = [
    { id: "b", title: "My birthday", kind: "birthday", freq: "yearly", month_of_year: 8, day_of_month: 14 },
    { id: "g", title: "File quarterly GST", kind: "filing", freq: "quarterly", month_of_year: 1, day_of_month: 10 },
  ];
  const html = renderAgenda(real, TODAY);
  assert.ok(html.includes("My birthday"));
  assert.ok(html.includes("Nothing else until File quarterly GST on Sat 10 Oct, in 2 months."));
}

// ---- the week --------------------------------------------------------------

{
  const html = renderWeek([...RULES(), TASK], { anchor: TODAY, today: TODAY, selected: null });
  // Seven rows, one per day, each a target.
  assert.equal((html.match(/class="cal-wrow[ "]/g) || []).length, 7);
  assert.ok(html.includes('data-day="2026-08-02"'));
  assert.ok(html.includes('data-day="2026-08-08"'));
  // The hour axis exists, reads in the app's one time format, and is fitted to
  // the hours this week actually uses (05:00 rent to 20:30 review, padded).
  assert.ok(/<div class="cal-axis"/.test(html));
  assert.ok(html.includes("<span>04:00</span>"));
  assert.ok(html.includes("<span>13:00</span>"), "the middle label is the true midpoint");
  assert.ok(html.includes("<span>22:00</span>"));
  // Timed items are blocks positioned by percentage; the all-day birthday is a
  // chip, never a block.
  assert.ok(/class="cal-wblock/.test(html));
  assert.ok(/left:\d+\.\d\d%/.test(html));
  // Today is marked, the past is marked, and the marks are classes not colours.
  assert.ok(html.includes("cal-wrow is-today") || html.includes("is-today"));
  assert.ok(html.includes("is-past"));
  // The agent task is drawn with its own glyph, not a reminder bell.
  assert.ok(html.includes(KIND_ICON.agent));
}
{
  // A week with only all-day items draws NO rail at all - an hour axis with
  // nothing on it invites you to read positions that do not exist.
  const html = renderWeek([{ id: "b", title: "Birthday", kind: "birthday", freq: "yearly", month_of_year: 8, day_of_month: 6 }],
    { anchor: TODAY, today: TODAY });
  assert.ok(!html.includes("cal-wrail"), "no rail when there is no clock");
  assert.ok(!html.includes("cal-axis"));
  assert.ok(html.includes("cal-wchip"), "the birthday is an all-day chip");
}
{
  // An empty week says so AND draws what IS coming - up to three of them, as
  // openable rows rather than one sentence. (Rent and the birthday only; the
  // weekly rules put something in every week by construction.)
  const html = renderWeek(RULES().slice(0, 2), { anchor: "2026-09-20", today: TODAY });
  assert.ok(html.includes("Nothing this week. What is coming:"));
  assert.ok(html.includes("Rent"), "the next real dates are drawn");
  assert.ok(html.includes("cal-jump"), "and each one jumps the calendar to that day");
}
{
  const html = renderWeek([], { anchor: TODAY, today: TODAY });
  assert.ok(html.includes("Nothing this week, and nothing ahead either."));
  assert.ok(!html.includes("cal-jump"), "no next date is invented when there is none");
}

// ---- the month -------------------------------------------------------------

{
  const html = renderMonth(RULES(), { year: 2026, month: 8, today: TODAY, selected: null, focus: TODAY });
  assert.equal((html.match(/role="row"/g) || []).length, 6, "six rows, always");
  assert.equal((html.match(/role="gridcell"/g) || []).length, 42);
  assert.ok(html.includes('role="grid"'));
  // Roving tabindex: exactly ONE cell is tabbable, and it is the focused one.
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
  assert.ok(html.includes(`data-day="${TODAY}"\n      tabindex="0"`) || /data-day="2026-08-06"[\s\S]{0,40}tabindex="0"/.test(html));
  // A cell announces its whole date and what is on it, not just "14".
  assert.ok(html.includes('aria-label="Friday 14 August 2026, 1 item, no set time"'));
  assert.ok(html.includes('aria-label="Saturday 1 August 2026, nothing scheduled"'));
  // Marks are SHAPES: filled for timed, ring for all-day.
  assert.ok(html.includes('<i class="is-timed"></i>'));
  assert.ok(html.includes('<i class="is-allday"></i>'));
}
{
  // Selection is announced as the current date, not merely coloured.
  const html = renderMonth(RULES(), { year: 2026, month: 8, today: TODAY, selected: "2026-08-14" });
  assert.ok(html.includes('aria-current="date"'));
  assert.ok(html.includes("is-selected"));
  // With no explicit focus the tabbable cell falls to the selection.
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
}
{
  // A month with nothing in it is a fact about the month. It must not read as a
  // fact about the user's life, so the next real date is named.
  const html = renderMonth([RULES()[1]], { year: 2026, month: 10, today: TODAY });
  assert.ok(html.includes("Nothing in October 2026. What is coming:"));
  assert.ok(html.includes("Birthday"), "and the next real date is drawn, not just named");
  assert.ok(html.includes('data-day="2026-08-14"'), "as a day the calendar can jump to");
  assert.ok(html.includes("cal-grid"), "the grid still draws - the month is real, it is just quiet");
}

// ---- the day detail --------------------------------------------------------

{
  const rows = RULES();
  const items = dayItems(rows, "2026-08-14");
  assert.equal(items.length, 1);
  const html = renderDayDetail(items, "2026-08-14", TODAY, { rows });
  assert.ok(html.includes("Friday 14 August 2026"));
  assert.ok(html.includes("in 8 days"));
  // The plain-English recurrence, from describeRule, is on screen.
  assert.ok(html.includes("every 14th August"));
  // And the honest note about WHEN a no-time reminder is actually said.
  assert.ok(html.includes("announced in the 07:00 brief"));
  assert.ok(html.includes("All day"));
  assert.ok(html.includes('data-cal-act="close-day"'));
}
{
  const rows = RULES();
  const html = renderDayDetail(dayItems(rows, "2026-09-05"), "2026-09-05", TODAY, { rows });
  assert.ok(html.includes("the 5th of every month at 05:00"), "the interval and the time both survive");
  assert.ok(!html.includes("announced in the 07:00 brief"), "a timed rule is not announced in the brief");
}
{
  // An empty day still names the next real thing.
  const rows = RULES();
  const html = renderDayDetail([], "2026-08-20", TODAY, { rows });
  assert.ok(html.includes("Nothing on Thu 20 Aug"));
  assert.ok(html.includes("Next is"));
}
{
  // A day in the past reads as the past. This is the branch that used to say
  // "in -4 days" - the calendar pages backwards, whenLabel() does not.
  const rows = RULES();
  const html = renderDayDetail(dayItems(rows, "2026-08-05"), "2026-08-05", TODAY, { rows });
  assert.ok(html.includes("yesterday"));
  assert.ok(!html.includes("in -"));
  assert.ok(renderDayDetail([], "2026-08-02", TODAY, { rows }).includes("4 days ago"));
}
assert.equal(renderDayDetail([], "not-a-date", TODAY, {}), "", "a bad key renders nothing, not a broken panel");

// ---- a scheduled task's run log, silence included --------------------------

{
  // SILENT runs are rendered. A check that ran and found nothing worth saying is
  // a different fact from a check that never ran, and this is the only surface
  // where the difference is visible.
  const html = renderTaskRuns(TASK, {
    rows: [
      { status: "silent", result: "silent: on track", started_at: "2026-08-02T15:00:00Z" },
      { status: "spoke", result: "spoke", started_at: "2026-07-26T15:00:00Z" },
      { status: "failed", result: "deepseek 500", started_at: "2026-07-19T15:00:00Z" },
    ],
  });
  assert.ok(html.includes(RUN_ICON.silent));
  assert.ok(html.includes("silent: on track"));
  assert.ok(html.includes('data-status="failed"'));
  assert.ok(html.includes("deepseek 500"));
  // IST, not UTC: 15:00Z is 20:30 in Asia/Kolkata, which is the slot it ran in.
  assert.ok(html.includes("2 Aug 20:30"), html.slice(0, 200));
  assert.ok(html.includes("the app runs this itself"));
}
{
  assert.ok(renderTaskRuns(TASK, { rows: [] }).includes("Has not run yet"));
  assert.ok(renderTaskRuns(TASK, { loading: true }).includes("Reading its run log"));
}
{
  // THE BRANCH THAT MATTERS: a run log that failed to load must not render as a
  // task that has never run.
  const html = renderTaskRuns(TASK, { problem: "permission denied" });
  assert.ok(html.includes("Couldn't read its run log: permission denied"));
  assert.ok(!html.includes("Has not run yet"));
  assert.ok(html.includes('data-cal-act="runs-retry"'));
  assert.ok(html.includes('data-task="t1"'));
}
{
  assert.equal(runStamp("nonsense"), "", "an unparseable timestamp is empty, never 'Invalid Date'");
  assert.ok(renderTaskRuns(TASK, { rows: [{ status: "silent", started_at: "nonsense" }] }).includes("time unknown"));
}

// ---- renderCalendar: the four honest states --------------------------------

const stateFor = (view) => ({ ...initialCalendarState(TODAY), view });

{
  // FAILED. The single most important assertion in this file: an errored read
  // renders as a failure with its reason and a retry, and NOT as an empty
  // calendar. "You have no deadlines" is a lie with a missed deadline as the
  // payload.
  const html = renderCalendar(stateFor("agenda"), [], TODAY, { error: "network timeout" });
  assert.ok(html.includes("Couldn't load your calendar: network timeout"));
  assert.ok(html.includes('data-cal-act="retry"'));
  assert.ok(!html.includes("Nothing scheduled"), "a failure never claims the calendar is empty");
  assert.ok(!html.includes("cal-grid") && !html.includes("cal-agenda"), "and it draws no calendar at all");
}
{
  // LOADING is its own state, not an empty one.
  const html = renderCalendar(stateFor("agenda"), [], TODAY, { loaded: false });
  assert.ok(html.includes("Loading your calendar"));
  assert.ok(html.includes('aria-busy="true"'));
  assert.ok(!html.includes("Nothing scheduled"));
}
{
  // GENUINELY EMPTY says what to do about it.
  const html = renderCalendar(stateFor("agenda"), [], TODAY, {});
  assert.ok(html.includes("Nothing scheduled yet"));
  assert.ok(html.includes("19 October 2002"), "it shows how to add one, in the owner's own words");
  assert.ok(!html.includes("Couldn't load"));
}
{
  // THE MIRROR FAILED. A connected calendar whose events could not be read must
  // never render as a calendar with no meetings in it - the same rule as tasks,
  // one table over, and the failure that this whole feature was built to survive.
  const html = renderCalendar(stateFor("agenda"), RULES(), TODAY, { eventError: "needs_reauth" });
  assert.ok(html.includes("Events from your connected calendars are missing: needs_reauth"));
  assert.ok(html.includes("Call mum"), "the reminders that DID load are still on screen");
  assert.ok(html.includes('data-cal-act="retry"'));
  assert.ok(
    calendarStatus(stateFor("agenda"), RULES(), TODAY, { eventError: "needs_reauth" })
      .includes("Events from your connected calendars could not be loaded"),
    "and the live region says it too",
  );
}
{
  // A MIRRORED EVENT IS DRAWN. Until 2026-08-08 calendar_events_raw had a fetcher
  // and no renderer, so connecting Google would have synced a year of meetings
  // into a calendar that still showed only the user's own rules.
  const meeting = {
    id: "gcal:e1", title: "Standup with Dr Mehta", kind: "event", freq: "once",
    on_date: "2026-08-07", at_time: "16:00", active: true, is_event: true,
    note: "Clinic", calendar_id: "work@example.com",
  };
  const html = renderCalendar(stateFor("agenda"), [...RULES(), meeting], TODAY, {});
  assert.ok(html.includes("Standup with Dr Mehta"));
  assert.ok(html.includes(KIND_ICON.event), "with the read-only glyph, not a reminder bell");
  const detail = renderDayDetail(dayItems([meeting], "2026-08-07"), "2026-08-07", TODAY, { rows: [meeting] });
  assert.ok(detail.includes("read-only"));
  assert.ok(detail.includes("work@example.com"));
  assert.ok(!detail.includes("announced in the 07:00 brief"), "this app does not fire somebody else's meeting");
}
{
  // TASKS FAILED but reminders loaded: the calendar still renders, and it names
  // what is MISSING from it rather than reporting that something went wrong.
  const html = renderCalendar(stateFor("agenda"), RULES(), TODAY, { taskError: "schema cache" });
  assert.ok(html.includes("Scheduled checks are missing from this calendar: schema cache"));
  assert.ok(html.includes("Call mum"), "the reminders that DID load are still on screen");
  assert.ok(html.includes('data-cal-act="retry"'));
}
{
  // The three views, and only the three.
  assert.deepEqual(VIEWS, ["agenda", "week", "month"]);
  for (const view of VIEWS) {
    const html = renderCalendar(stateFor(view), RULES(), TODAY, {});
    assert.ok(html.includes(`data-view="${view}" class="is-on"`), `${view} toggle is pressed`);
    assert.ok(html.includes(`aria-pressed="true"`));
    assert.ok(html.includes(`<div class="cal-body" data-view="${view}">`));
  }
  const bad = renderCalendar({ ...initialCalendarState(TODAY), view: "hologram" }, RULES(), TODAY, {});
  assert.ok(bad.includes('data-view="agenda" class="is-on"'), "an unknown view falls back to the agenda");
}
{
  // Selecting a day renders the detail under whichever view is on screen.
  const html = renderCalendar({ ...initialCalendarState(TODAY), view: "month", selected: "2026-08-14" }, RULES(), TODAY, {});
  assert.ok(html.includes("cal-grid"));
  assert.ok(html.includes("cal-detail"));
  assert.ok(html.includes("Friday 14 August 2026"));
}

// ---- the live region -------------------------------------------------------

{
  // One short sentence. A polite region that reads the whole calendar out on
  // every tap is a region people switch off.
  assert.equal(calendarStatus(stateFor("agenda"), [], TODAY, { error: "boom" }), "Calendar failed to load: boom");
  assert.equal(calendarStatus(stateFor("agenda"), [], TODAY, { loaded: false }), "Loading calendar");
  assert.equal(
    calendarStatus({ ...initialCalendarState(TODAY), selected: "2026-08-14" }, RULES(), TODAY, {}),
    "Friday 14 August 2026: 1 item, no set time",
  );
  // Rent + birthday + two weekly rules on four August Thursdays.
  assert.equal(calendarStatus(stateFor("month"), RULES(), TODAY, {}), "August 2026: 10 items");
  assert.equal(calendarStatus(stateFor("week"), RULES(), TODAY, {}), "Week of 2 - 8 Aug: 3 items");
  assert.match(calendarStatus(stateFor("agenda"), RULES(), TODAY, {}), /^Agenda: \d+ items in the next 21 days$/);
  assert.ok(calendarStatus(stateFor("month"), RULES(), TODAY, { taskError: "x" }).endsWith("Scheduled checks could not be loaded."));
}

// ---- escaping: a reminder title is whatever the user said -------------------

{
  const nasty = [{
    id: "x", title: '<img src=x onerror="alert(1)">', kind: "other",
    freq: "once", on_date: "2026-08-10", note: "<script>bad</script>",
  }];
  for (const html of [
    renderAgenda(nasty, TODAY),
    renderWeek(nasty, { anchor: "2026-08-09", today: TODAY }),
    renderMonth(nasty, { year: 2026, month: 8, today: TODAY }),
    renderDayDetail(dayItems(nasty, "2026-08-10"), "2026-08-10", TODAY, { rows: nasty }),
    renderCalendar(stateFor("agenda"), nasty, TODAY, {}),
    renderCalendar(stateFor("agenda"), [], TODAY, { error: '<img src=x onerror="alert(1)">' }),
  ]) {
    assert.ok(!html.includes("<img"), "titles are escaped");
    assert.ok(!html.includes("<script>"), "and so is everything else");
  }
  assert.equal(escapeHtml(`<&">'`), "&lt;&amp;&quot;&gt;&#39;", "all five, and & first so it cannot double-escape");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
}

// ---- initial state and countUpcoming ---------------------------------------

{
  const s = initialCalendarState(TODAY);
  assert.deepEqual(s, { view: "agenda", year: 2026, month: 8, anchor: TODAY, selected: null, focus: TODAY });
  assert.equal(countUpcoming(RULES()[0], TODAY, 365), 12, "monthly rent fires twelve times a year");
  assert.equal(countUpcoming(RULES()[1], TODAY, 365), 1, "a birthday fires once");
  assert.equal(countUpcoming({ freq: "nonsense" }, TODAY, 365), 0, "a rule that cannot fire counts zero");
}

console.log("calendar-ui tests passed");
