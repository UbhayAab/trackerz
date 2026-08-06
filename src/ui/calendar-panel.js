// THE CALENDAR - agenda, week and month, hand-rolled.
//
// WHY IT IS HAND-ROLLED. Settled by measurement in
// docs/OSS-CALENDAR-RESEARCH-2026-08-06.md, not by taste: `@event-calendar/core`
// is NOT runtime-free (four bare `svelte` imports, Svelte 5 in `dependencies`,
// 57 files and 284,673 bytes vendored - about 45% of everything in vendor/ for
// one widget). FullCalendar and Toast UI each bundle Preact. The only zero-runtime
// candidates found - vanilla-calendar-pro, cally - are date PICKERS that cannot
// draw events at all. Everything here ships to GitHub Pages and is baked into the
// APK, so those bytes are a real cost paid by a real phone.
//
// WHY THERE IS NO SIXTH TAB, and no new page. A tab costs more than it looks:
// tests/navigation.test.mjs hard-asserts NAV_TABS.length === 5 and the exact id
// array, scripts/build-nav.mjs re-stamps every page from it, sw.js's APP_SHELL
// needs the new URL or the page breaks offline, and five tabs already barely fit
// a 320px phone. So this renders INTO the container that already exists:
// `#remindersStrip` on Home. Settings keeps the manage list it already has.
//
// THE 320px BUDGET, measured rather than guessed. .app-shell is padding-inline
// 10px under 520px, so a 320px phone gives the calendar 300px. Seven month cells
// with 2px gutters is 41px wide each - under the 44px thumb target, and there is
// no arrangement of seven columns inside 300px that reaches 44. The cells are
// therefore 41 x 46: short in the axis that cannot be helped, comfortable in the
// one that can. Everything that is a real target on its own - view toggles, month
// arrows, week rows, agenda day headings - is >= 44px tall.
//
// TIME OF DAY IS DRAWN, and drawn as rows-are-days / left-to-right-is-the-hour
// rather than the usual seven skinny columns. Seven columns inside 300px is 38px
// per day, which can hold a coloured smear and nothing else; a day per row gives
// each day a 46px band, room for a readable rail, and lanes to stack collisions
// into. The hour axis is shared by all seven rows, so positions are comparable.
//
// AN ITEM WITH NO TIME IS NEVER DRAWN ON THE RAIL. It goes in an all-day lane and
// says "All day". Placing a no-time reminder at midnight would be a fabricated
// fact of exactly the kind this codebase keeps having to delete.
//
// DOM only. No data fetching, no AI logic (tests/architecture.test.mjs). Every
// function above bindCalendar() is pure and covered by tests/calendar-ui.test.mjs.

import {
  agendaBetween, weekdayOf, addDays, daysInMonth, toKey, parseKey, compareKeys,
  describeRule, whenLabel, daysBetween, minutesOfDay, formatTime, occurrencesBetween, upcoming,
} from "../../lib/reminders.mjs";
import { dayKeyInTz, minuteOfDayInTz, DEFAULT_TZ } from "../../lib/tz.mjs";

const WEEK_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEK_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export const VIEWS = ["agenda", "week", "month"];

// GLYPH, not colour. A colour-only distinction is invisible to a colourblind
// reader and to the grayscale screenshot in docs/, so every item type carries a
// shape of its own and colour only ever repeats what the glyph already said.
export const KIND_ICON = {
  birthday: "🎂", anniversary: "💍", bill: "💸", filing: "🧾",
  appointment: "📅", task: "🔔", other: "🔔",
  // A check the APP runs on itself, not a bell it rings at you.
  agent: "🤖",
};

// The outcomes of one autonomous run. `silent` has a glyph because silence with
// a trace is a feature of this system: a check that ran and found nothing worth
// saying is a different fact from a check that never ran, and the UI has to be
// able to tell them apart on sight.
export const RUN_ICON = {
  spoke: "💬", silent: "🤫", blocked: "⛔", failed: "⚠️", running: "⏳",
};

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---- dates, all from the key's own parts so nothing can shift by a zone ------

// "Thu 14 Aug" - the compact heading. Never built from a Date object.
export function dayHeading(key, today) {
  const p = parseKey(key);
  if (!p) return "";
  const away = daysBetween(today, key);
  if (away === 0) return "Today";
  if (away === 1) return "Tomorrow";
  return `${WEEK_SHORT[weekdayOf(key)]} ${p.d} ${MONTH_NAMES[p.m - 1].slice(0, 3)}`;
}

// "Thursday 14 August 2026" - what a screen reader should hear. A cell that only
// announces "14" is a cell nobody can navigate.
export function longDayHeading(key) {
  const p = parseKey(key);
  if (!p) return "";
  return `${WEEK_LONG[weekdayOf(key)]} ${p.d} ${MONTH_NAMES[p.m - 1]} ${p.y}`;
}

// whenLabel() only knows the future - it is written for "your GST filing is due
// in 3 days" - and a calendar you can page BACKWARDS through will hand it a
// negative, which it renders as "in -4 days". A day detail opened on last Sunday
// has to read as English, so the past is spelled out here rather than left to a
// function that was never asked the question.
export function awayLabel(today, key) {
  const n = daysBetween(today, key);
  if (n == null) return "";
  if (n >= 0) return whenLabel(n);
  const back = -n;
  if (back === 1) return "yesterday";
  if (back < 14) return `${back} days ago`;
  if (back < 60) return `${Math.round(back / 7)} weeks ago`;
  return `${Math.round(back / 30)} months ago`;
}

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// Step a (year, month) pair by n months. Integer arithmetic, like everything else.
export function stepMonth(year, month, n) {
  const idx = year * 12 + (month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

// The seven keys of the week containing `key`, Sunday first - matching
// weekdayOf(), where 0 is Sunday, so the week grid and the month grid start on
// the same day and a date cannot appear in a different column in each.
export function weekKeys(key) {
  const wd = weekdayOf(key);
  if (wd == null) return [];
  const start = addDays(key, -wd);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// "3 - 9 Aug" within a month, "31 Jul - 6 Aug" across one, "27 Dec - 2 Jan" across
// a year. Naming both months only when they differ keeps the header short enough
// for 320px without ever being ambiguous.
export function weekLabel(keys) {
  const a = parseKey(keys[0]);
  const b = parseKey(keys[6]);
  if (!a || !b) return "";
  const ma = MONTH_NAMES[a.m - 1].slice(0, 3);
  const mb = MONTH_NAMES[b.m - 1].slice(0, 3);
  if (a.y !== b.y) return `${a.d} ${ma} ${a.y} - ${b.d} ${mb} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${ma} - ${b.d} ${mb}`;
  return `${a.d} - ${b.d} ${mb}`;
}

// Where the keyboard goes from here. Returned as a date key so the caller can
// derive the month and the week from one value instead of keeping three cursors.
export function stepFocus(key, action) {
  const p = parseKey(key);
  if (!p) return key;
  if (action === "left") return addDays(key, -1);
  if (action === "right") return addDays(key, 1);
  if (action === "up") return addDays(key, -7);
  if (action === "down") return addDays(key, 7);
  if (action === "weekStart") return addDays(key, -weekdayOf(key));
  if (action === "weekEnd") return addDays(key, 6 - weekdayOf(key));
  if (action === "prevMonth" || action === "nextMonth") {
    const { year, month } = stepMonth(p.y, p.m, action === "prevMonth" ? -1 : 1);
    // Clamped, not rolled: 31 March going back a month is 28 February, not
    // 3 March. Same rule the recurrence engine uses, for the same reason.
    return toKey(year, month, Math.min(p.d, daysInMonth(year, month)));
  }
  return key;
}

// ---- the month grid ---------------------------------------------------------

// The 42 cells of a month: leading blanks from the previous month, the month
// itself, then trailing blanks. Six rows always, so the grid does not resize as
// you page through months and shove the rest of Home up and down.
//
// `timed` and `allDay` are counted separately because the cell marks them with
// different SHAPES - a filled dot for something with a clock, a ring for
// something that only has a date.
export function monthCells(year, month, { marks = {}, today = null } = {}) {
  const first = toKey(year, month, 1);
  const lead = weekdayOf(first);
  const dim = daysInMonth(year, month);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ key: null, day: null, inMonth: false });
  for (let d = 1; d <= dim; d++) {
    const key = toKey(year, month, d);
    const items = marks[key] || [];
    let timed = 0;
    for (const it of items) if (minutesOfDay(it.at_time) != null) timed += 1;
    cells.push({
      key,
      day: d,
      inMonth: true,
      count: items.length,
      timed,
      allDay: items.length - timed,
      isToday: key === today,
      isPast: today != null && compareKeys(key, today) < 0,
      kinds: [...new Set(items.map((r) => r.kind || "task"))],
    });
  }
  while (cells.length < 42) cells.push({ key: null, day: null, inMonth: false });
  return cells;
}

// ---- the time rail ----------------------------------------------------------

/**
 * The hour window the week rail draws, from the times that are actually there.
 *
 * A fixed 00:00-24:00 axis spends most of its width on hours nothing ever
 * happens in, which at 300px means every event lands in the same 40px. This
 * fits the window to the day's real range, padded to whole hours, and falls back
 * to a plain 08:00-20:00 when there is nothing timed at all - a window with no
 * events in it is a decoration, so `hasTimed` lets the caller not draw it.
 */
export function timeWindow(byDay, keys, { padMin = 60, minSpanMin = 180 } = {}) {
  let lo = null;
  let hi = null;
  for (const k of keys || []) {
    for (const it of (byDay && byDay[k]) || []) {
      const at = minutesOfDay(it.at_time);
      if (at == null) continue;
      lo = lo == null ? at : Math.min(lo, at);
      hi = hi == null ? at : Math.max(hi, at);
    }
  }
  if (lo == null) return { startMin: 8 * 60, endMin: 20 * 60, hasTimed: false };
  let start = Math.max(0, Math.floor((lo - padMin) / 60) * 60);
  let end = Math.min(1440, Math.ceil((hi + padMin) / 60) * 60);
  // A one-event day would otherwise get a two-hour axis, on which "18:30" and
  // "18:45" look like opposite ends of the day.
  while (end - start < minSpanMin && (start > 0 || end < 1440)) {
    if (start > 0) start = Math.max(0, start - 60);
    if (end - start >= minSpanMin) break;
    if (end < 1440) end = Math.min(1440, end + 60);
  }
  return { startMin: start, endMin: end, hasTimed: true };
}

/**
 * One day's items, split into the all-day lane and positioned blocks.
 *
 * A reminder is a point in time, not a span, so a block is given a nominal width
 * (`minSpanMin`) purely so it can be seen and hit. Two points inside that width
 * would draw on top of each other, so blocks are packed into LANES by first fit:
 * lane 0 until something collides, then lane 1, and the row grows taller. Nothing
 * is ever moved off its true time to make room - `leftPct` is always the real
 * minute - because a calendar that slides an event to a tidier slot is lying
 * about when it is.
 */
export function laneLayout(items, { startMin = 0, endMin = 1440, minSpanMin = 45 } = {}) {
  const allDay = [];
  const timed = [];
  for (const it of items || []) {
    const at = minutesOfDay(it.at_time);
    if (at == null) { allDay.push(it); continue; }
    timed.push({ item: it, at });
  }
  timed.sort((a, b) => a.at - b.at || String(a.item.title).localeCompare(String(b.item.title)));

  const span = Math.max(1, endMin - startMin);
  const width = Math.min(minSpanMin, span);
  const laneEnds = [];
  const blocks = [];
  for (const t of timed) {
    const clipped = t.at < startMin || t.at > endMin;
    const start = Math.min(Math.max(t.at, startMin), endMin);
    const end = Math.min(endMin, start + width);
    let lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] > start) lane += 1;
    laneEnds[lane] = end;
    blocks.push({
      item: t.item,
      atMin: t.at,
      lane,
      clipped,
      leftPct: ((start - startMin) / span) * 100,
      widthPct: ((end - start) / span) * 100,
    });
  }
  return { allDay, blocks, lanes: Math.max(1, laneEnds.length) };
}

// ---- small shared pieces ----------------------------------------------------

function iconFor(row) {
  return KIND_ICON[row && row.kind] || KIND_ICON.other;
}

// The time, or the fact that there ISN'T one. "All day" is written out rather
// than left blank: a missing chip reads as a rendering gap, a stated one reads as
// a property of the reminder.
function timeChip(r) {
  const mins = minutesOfDay(r.at_time);
  return mins == null
    ? `<span class="cal-time is-allday">All day</span>`
    : `<span class="cal-time">${escapeHtml(formatTime(mins))}</span>`;
}

function itemLine(r) {
  return `<li class="cal-item" data-kind="${escapeHtml(r.kind || "task")}">
      <span class="cal-icon" aria-hidden="true">${iconFor(r)}</span>
      <span class="cal-title">${escapeHtml(r.title)}</span>
      ${timeChip(r)}
    </li>`;
}

// "2 items, first at 09:00" - what the day button announces. Screen-reader users
// get the same summary a sighted user reads off the dots.
export function daySummary(items) {
  const list = items || [];
  if (!list.length) return "nothing scheduled";
  const times = list.map((r) => minutesOfDay(r.at_time)).filter((m) => m != null).sort((a, b) => a - b);
  const noun = list.length === 1 ? "1 item" : `${list.length} items`;
  if (!times.length) return `${noun}, no set time`;
  return `${noun}, first at ${formatTime(times[0])}`;
}

function emptyDayNote(key, today, rows) {
  const next = upcoming(rows || [], today, { limit: 1, withinDays: 4000 })[0];
  const tail = next
    ? ` Next is ${escapeHtml(next.title)} on ${escapeHtml(dayHeading(next.next_due_on, today))}.`
    : "";
  return `<p class="cal-empty">Nothing on ${escapeHtml(dayHeading(key, today))}.${tail}</p>`;
}

// ---- the agenda: what is coming, grouped by day -----------------------------

/**
 * `rows` are reminder RULES. Everything date-shaped is computed here from the
 * rules rather than stored, so the list and the engine that fires them cannot
 * disagree about a date the user is relying on.
 */
export function renderAgenda(rows, today, { days = 21, limitDays = 8, selected = null } = {}) {
  const to = addDays(today, days);
  const byDay = agendaBetween(rows || [], today, to);
  const all = Object.keys(byDay).sort();
  const keys = all.slice(0, limitDays);
  if (!keys.length) {
    // Empty HERE is not empty overall, and saying which is the difference between
    // "quiet fortnight" and "your calendar is broken".
    const next = upcoming(rows || [], today, { limit: 1, withinDays: 4000 })[0];
    return next
      ? `<p class="cal-empty">Nothing in the next ${days} days. Next is ${escapeHtml(next.title)} on ${escapeHtml(dayHeading(next.next_due_on, today))}, ${escapeHtml(whenLabel(next.days_away))}.</p>`
      : `<p class="cal-empty">Nothing scheduled in the next ${days} days.</p>`;
  }
  const more = all.length - keys.length;
  // Nothing was truncated, so the agenda has shown everything it knows about -
  // and the next real thing is BEYOND the window. Naming it is the difference
  // between "one birthday and then who knows" and a calendar you can trust: the
  // owner's live data is exactly this shape, a birthday inside the window and a
  // GST filing two months past it.
  const beyond = more > 0 ? null : upcoming(rows || [], addDays(to, 1), { limit: 1, withinDays: 4000 })[0];
  const foot = more > 0
    ? `<p class="cal-foot">${more} more ${more === 1 ? "day" : "days"} in the next ${days}.</p>`
    : beyond
      ? `<p class="cal-foot">Nothing else until ${escapeHtml(beyond.title)} on ${escapeHtml(dayHeading(beyond.next_due_on, today))}, ${escapeHtml(awayLabel(today, beyond.next_due_on))}.</p>`
      : "";
  return `<ul class="cal-agenda">${keys.map((key) => `
    <li class="cal-agenda-day${key === today ? " is-today" : ""}">
      <button type="button" class="cal-agenda-head${key === selected ? " is-open" : ""}" data-day="${key}"
        aria-expanded="${key === selected}"
        aria-label="${escapeHtml(longDayHeading(key))}, ${escapeHtml(daySummary(byDay[key]))}">
        <span class="cal-agenda-when">${escapeHtml(dayHeading(key, today))}</span>
        <span class="cal-agenda-away">${escapeHtml(awayLabel(today, key))}</span>
      </button>
      <ul class="cal-agenda-items">${byDay[key].map(itemLine).join("")}</ul>
    </li>`).join("")}</ul>${foot}`;
}

// ---- the week: a day per row, the hour left to right ------------------------

export function renderWeek(rows, { anchor, today, selected = null } = {}) {
  const keys = weekKeys(anchor);
  if (!keys.length) return `<p class="cal-empty">That week could not be read.</p>`;
  const byDay = agendaBetween(rows || [], keys[0], keys[6]);
  const win = timeWindow(byDay, keys);
  let inWeek = 0;
  for (const k of keys) inWeek += (byDay[k] || []).length;

  const axis = win.hasTimed
    ? `<div class="cal-axis" aria-hidden="true">
        <span>${escapeHtml(formatTime(win.startMin))}</span>
        <span>${escapeHtml(formatTime(Math.round((win.startMin + win.endMin) / 2)))}</span>
        <span>${escapeHtml(formatTime(win.endMin))}</span>
      </div>`
    : "";

  const rowsHtml = keys.map((key) => {
    const items = byDay[key] || [];
    const { allDay, blocks, lanes } = laneLayout(items, win);
    const cls = ["cal-wrow"];
    if (key === today) cls.push("is-today");
    if (key === selected) cls.push("is-selected");
    if (!items.length) cls.push("is-empty");
    if (today != null && compareKeys(key, today) < 0) cls.push("is-past");
    const p = parseKey(key);

    const chips = allDay.length
      ? `<span class="cal-wallday">${allDay.map((r) => `
          <span class="cal-wchip" data-kind="${escapeHtml(r.kind || "task")}">
            <span aria-hidden="true">${iconFor(r)}</span>${escapeHtml(r.title)}
          </span>`).join("")}</span>`
      : "";

    // The rail is only drawn when the week HAS a clock in it. An axis over seven
    // empty rails is furniture that teaches you to stop reading it.
    const rail = win.hasTimed
      ? `<span class="cal-wrail" style="height:${lanes * 19 + 2}px">${blocks.map((b) => `
          <span class="cal-wblock${b.clipped ? " is-clipped" : ""}" data-kind="${escapeHtml(b.item.kind || "task")}"
            style="left:${b.leftPct.toFixed(2)}%;width:${b.widthPct.toFixed(2)}%;top:${b.lane * 19 + 1}px"
            aria-hidden="true">${iconFor(b.item)}</span>`).join("")}</span>`
      : "";

    return `<button type="button" class="${cls.join(" ")}" data-day="${key}"
      aria-label="${escapeHtml(longDayHeading(key))}, ${escapeHtml(daySummary(items))}"
      ${key === selected ? 'aria-current="date"' : ""}>
      <span class="cal-wday"><b>${WEEK_SHORT[weekdayOf(key)]}</b><i>${p ? p.d : ""}</i></span>
      <span class="cal-wtrack">${chips}${rail}</span>
    </button>`;
  }).join("");

  const nothing = inWeek === 0 ? emptyRangeNote(rows, today, `this week`) : "";

  return `<div class="cal-week">
      <div class="cal-range-head">
        <button type="button" class="cal-nav" data-step="-1" aria-label="Previous week">‹</button>
        <strong>${escapeHtml(weekLabel(keys))}</strong>
        <button type="button" class="cal-nav" data-step="1" aria-label="Next week">›</button>
      </div>
      ${axis}
      <div class="cal-wrows">${rowsHtml}</div>
      ${nothing}
    </div>`;
}

// "Nothing in August" is a fact about August. "You have no deadlines" is a claim
// about the user's life, and only one of those is true here - so the empty range
// always names the next real thing when there is one.
function emptyRangeNote(rows, today, what) {
  const next = upcoming(rows || [], today, { limit: 1, withinDays: 4000 })[0];
  return next
    ? `<p class="cal-empty">Nothing ${escapeHtml(what)}. Next is ${escapeHtml(next.title)} on ${escapeHtml(dayHeading(next.next_due_on, today))}, ${escapeHtml(whenLabel(next.days_away))}.</p>`
    : `<p class="cal-empty">Nothing ${escapeHtml(what)}.</p>`;
}

// ---- the month grid ---------------------------------------------------------

export function renderMonth(rows, { year, month, today, selected = null, focus = null } = {}) {
  const first = toKey(year, month, 1);
  const last = toKey(year, month, daysInMonth(year, month));
  const marks = agendaBetween(rows || [], first, last);
  const cells = monthCells(year, month, { marks, today });
  let inMonth = 0;
  for (const k of Object.keys(marks)) inMonth += marks[k].length;

  // Roving tabindex: exactly one cell in the grid is tabbable, and the arrow keys
  // move it. Seven-and-forty stops on the way past a calendar is not navigation.
  // `c.key` is null on the padding cells, so every candidate has to be checked
  // for truthiness first: without it a null focus "matches" a blank and the grid
  // renders with nothing tabbable at all - a keyboard trap in reverse.
  const inGrid = (k) => Boolean(k) && cells.some((c) => c.key === k);
  const focusKey = inGrid(focus) ? focus
    : inGrid(selected) ? selected
      : inGrid(today) ? today
        : first;

  const cellHtml = (c) => {
    if (!c.inMonth) return `<span class="cal-cell is-blank" role="gridcell" aria-hidden="true"></span>`;
    const cls = ["cal-cell"];
    if (c.isToday) cls.push("is-today");
    if (c.isPast) cls.push("is-past");
    if (c.count) cls.push("has-events");
    if (c.key === selected) cls.push("is-selected");
    // SHAPE, not colour: a filled dot has a clock on it, a ring only has a date.
    // Capped at three - past that the marks stop meaning anything at 41px wide
    // and start overflowing the cell.
    const shown = Math.min(3, c.count);
    let marksHtml = "";
    for (let i = 0; i < shown; i++) {
      marksHtml += i < c.timed ? `<i class="is-timed"></i>` : `<i class="is-allday"></i>`;
    }
    const dots = c.count ? `<span class="cal-dots" aria-hidden="true">${marksHtml}</span>` : "";
    return `<button type="button" class="${cls.join(" ")}" role="gridcell" data-day="${c.key}"
      tabindex="${c.key === focusKey ? "0" : "-1"}"
      aria-label="${escapeHtml(longDayHeading(c.key))}, ${escapeHtml(daySummary(marks[c.key]))}"
      ${c.key === selected ? 'aria-current="date"' : ""}>${c.day}${dots}</button>`;
  };

  const grid = [0, 1, 2, 3, 4, 5]
    .map((r) => `<div class="cal-row" role="row">${cells.slice(r * 7, r * 7 + 7).map(cellHtml).join("")}</div>`)
    .join("");

  return `
    <div class="cal-month">
      <div class="cal-range-head">
        <button type="button" class="cal-nav" data-step="-1" aria-label="Previous month">‹</button>
        <strong>${escapeHtml(monthLabel(year, month))}</strong>
        <button type="button" class="cal-nav" data-step="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-weekdays" aria-hidden="true">${WEEK_LETTERS.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-grid" role="grid" aria-label="${escapeHtml(monthLabel(year, month))}">${grid}</div>
      ${inMonth === 0 ? emptyRangeNote(rows, today, `in ${monthLabel(year, month)}`) : ""}
    </div>`;
}

// ---- the day detail ---------------------------------------------------------

/**
 * One day, everything on it, in words.
 *
 * `runs` is { [task_id]: { loading } | { rows } | { problem } } - the last few
 * runs of a scheduled check, fetched by the caller. All four states are drawn.
 * A task whose run log failed to load must NOT render as a task that has never
 * run: that is the same lie as an empty calendar, one level down.
 */
export function renderDayDetail(items, key, today, { rows = [], runs = {} } = {}) {
  if (!parseKey(key)) return "";
  const list = items || [];
  const head = `<div class="cal-detail-head">
      <strong>${escapeHtml(longDayHeading(key))}</strong>
      <span>${escapeHtml(awayLabel(today, key))}</span>
      <button type="button" class="cal-close" data-cal-act="close-day" aria-label="Close ${escapeHtml(longDayHeading(key))}">✕</button>
    </div>`;
  if (!list.length) return `<div class="cal-detail">${head}${emptyDayNote(key, today, rows)}</div>`;

  const body = list.map((r) => {
    const mins = minutesOfDay(r.at_time);
    // A reminder with no clock is not fired at midnight - it is announced in the
    // morning brief. Saying so is the difference between a gap and a rule.
    const rule = `${describeRule(r)}${mins == null && !r.is_task ? " · announced in the 07:00 brief" : ""}`;
    return `<li class="cal-item is-detail" data-kind="${escapeHtml(r.kind || "task")}">
        <span class="cal-icon" aria-hidden="true">${iconFor(r)}</span>
        <span class="cal-title">${escapeHtml(r.title)}</span>
        ${timeChip(r)}
        <small class="cal-rule">${escapeHtml(rule)}</small>
        ${r.is_task ? renderTaskRuns(r, runs[r.task_id]) : ""}
      </li>`;
  }).join("");

  return `<div class="cal-detail">${head}<ul class="cal-day-list">${body}</ul></div>`;
}

// The last few runs of one scheduled check, SILENT ones included. A silent run is
// the system working; rendering the log as blank because nothing was said would
// hide the only evidence that it ran at all.
export function renderTaskRuns(row, state) {
  const intent = `<small class="cal-rule">the app runs this itself · ${escapeHtml(row.intent || "check")}</small>`;
  if (!state) return intent;
  if (state.loading) return `${intent}<small class="cal-runs-note">Reading its run log…</small>`;
  if (state.problem) {
    return `${intent}<small class="cal-runs-note is-bad">Couldn't read its run log: ${escapeHtml(state.problem)}
      <button type="button" class="cal-linklike" data-cal-act="runs-retry" data-task="${escapeHtml(row.task_id)}">Retry</button></small>`;
  }
  const list = state.rows || [];
  if (!list.length) return `${intent}<small class="cal-runs-note">Has not run yet.</small>`;
  return `${intent}<ul class="cal-runs">${list.slice(0, 4).map((run) => {
    const status = String(run.status || "unknown");
    const stamp = runStamp(run.started_at || run.finished_at);
    return `<li data-status="${escapeHtml(status)}">
        <span aria-hidden="true">${RUN_ICON[status] || "•"}</span>
        <b>${escapeHtml(status)}</b>
        <span class="cal-run-when">${escapeHtml(stamp || "time unknown")}</span>
        ${run.result ? `<span class="cal-run-note">${escapeHtml(String(run.result).slice(0, 90))}</span>` : ""}
      </li>`;
  }).join("")}</ul>`;
}

// "5 Aug 20:30" in the user's zone. Returns "" rather than "Invalid Date" for a
// timestamp that will not parse - the caller says "time unknown", which is true.
export function runStamp(iso, tz = DEFAULT_TZ) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  const p = parseKey(dayKeyInTz(ms, tz));
  if (!p) return "";
  return `${p.d} ${MONTH_NAMES[p.m - 1].slice(0, 3)} ${formatTime(minuteOfDayInTz(ms, tz))}`;
}

// ---- the whole panel --------------------------------------------------------

/**
 * `state` = { view, year, month, anchor, selected, focus }.
 *
 * FOUR STATES, kept apart on purpose:
 *   loading  - the read has not come back
 *   failed   - it came back as an error, with the reason and a retry
 *   empty    - it came back, and there is genuinely nothing
 *   empty-here - nothing in THIS month/week, and the next real date is named
 *
 * A failed read must never render as an empty calendar. "You have no deadlines"
 * is a lie with a missed deadline as the payload, and it is the one this file
 * most has to get right.
 *
 * `taskError` is separate from `error` because the two reads are separate
 * (src/ui/reminders-panel.js fetches reminders and agent tasks independently).
 * A calendar that hid every reminder because the task table errored would be a
 * worse outage than the one it is reporting.
 */
export function renderCalendar(state, rows, today, opts = {}) {
  const { error = null, taskError = null, loaded = true, runs = {} } = opts;
  const view = VIEWS.includes(state && state.view) ? state.view : "agenda";
  const head = `
    <div class="cal-head">
      <p class="chips-label">Coming up</p>
      <div class="cal-toggle" role="group" aria-label="Calendar view">
        ${VIEWS.map((v) => `<button type="button" data-view="${v}" class="${view === v ? "is-on" : ""}" aria-pressed="${view === v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join("")}
      </div>
    </div>`;

  if (error) {
    return `${head}<div class="cal-body"><p class="chips-error">Couldn't load your calendar: ${escapeHtml(error)}</p>
      <p class="cal-empty">Nothing below is missing because you have nothing - it is missing because this read failed.</p>
      <button type="button" class="cal-retry" data-cal-act="retry">Try again</button></div>`;
  }
  if (!loaded) {
    return `${head}<div class="cal-body" aria-busy="true"><p class="cal-empty">Loading your calendar…</p></div>`;
  }

  // The app's own scheduled checks failed while the reminders loaded. Name what
  // is missing from the picture rather than reporting that something went wrong.
  const taskNote = taskError
    ? `<p class="chips-error">Scheduled checks are missing from this calendar: ${escapeHtml(taskError)}
        <button type="button" class="cal-linklike" data-cal-act="retry">Retry</button></p>`
    : "";

  const all = rows || [];
  if (!all.length) {
    return `${head}<div class="cal-body">${taskNote}<p class="cal-empty">Nothing scheduled yet. Say something like "my birthday is 14 August" or "remind me to file GST on the 10th of every 3rd month" in a capture and it lands here.</p></div>`;
  }

  const body = view === "month"
    ? renderMonth(all, { year: state.year, month: state.month, today, selected: state.selected, focus: state.focus })
    : view === "week"
      ? renderWeek(all, { anchor: state.anchor || today, today, selected: state.selected })
      : renderAgenda(all, today, { selected: state.selected });

  const detail = state.selected
    ? renderDayDetail(dayItems(all, state.selected), state.selected, today, { rows: all, runs })
    : "";

  return `${head}<div class="cal-body" data-view="${view}">${taskNote}${body}${detail}</div>`;
}

// Everything that falls on one day, from the rules. One call, so the detail panel
// and the grid cannot disagree about what is on a date.
export function dayItems(rows, key) {
  if (!parseKey(key)) return [];
  return agendaBetween(rows || [], key, key)[key] || [];
}

/**
 * The one sentence a screen reader should hear after a change. Short on purpose:
 * a polite live region that reads the whole calendar out on every tap is a region
 * people switch off. Never assertive - nothing here interrupts anything.
 */
export function calendarStatus(state, rows, today, opts = {}) {
  const { error = null, taskError = null, loaded = true } = opts;
  if (error) return `Calendar failed to load: ${error}`;
  if (!loaded) return "Loading calendar";
  const all = rows || [];
  if (state && state.selected) {
    return `${longDayHeading(state.selected)}: ${daySummary(dayItems(all, state.selected))}`;
  }
  const view = VIEWS.includes(state && state.view) ? state.view : "agenda";
  let sentence = "";
  if (view === "month") {
    const first = toKey(state.year, state.month, 1);
    const last = toKey(state.year, state.month, daysInMonth(state.year, state.month));
    sentence = `${monthLabel(state.year, state.month)}: ${countBetween(all, first, last)}`;
  } else if (view === "week") {
    const keys = weekKeys(state.anchor || today);
    sentence = `Week of ${weekLabel(keys)}: ${countBetween(all, keys[0], keys[6])}`;
  } else {
    sentence = `Agenda: ${countBetween(all, today, addDays(today, 21))} in the next 21 days`;
  }
  return taskError ? `${sentence}. Scheduled checks could not be loaded.` : sentence;
}

function countBetween(rows, from, to) {
  const byDay = agendaBetween(rows || [], from, to);
  let n = 0;
  for (const k of Object.keys(byDay)) n += byDay[k].length;
  return n === 1 ? "1 item" : `${n} items`;
}

// ---- binding ----------------------------------------------------------------

// Arrow keys move the selected day; Enter and Space open it, which the button
// element already does for free, so they are deliberately absent from this map.
const KEY_ACTIONS = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Home: "weekStart", End: "weekEnd", PageUp: "prevMonth", PageDown: "nextMonth",
};

/**
 * Wire one container. `onChange(nextState)` is called with the new state and the
 * caller re-renders - no internal DOM mutation, so the render function stays the
 * single description of what the panel looks like.
 *
 * `handlers.onRetry(taskId?)` re-runs the read that failed.
 */
export function bindCalendar(el, getState, onChange, handlers = {}) {
  if (!el || el.dataset.calBound === "1") return;
  el.dataset.calBound = "1";

  // Every render replaces the panel's markup, which throws away whatever the
  // keyboard was standing on. Re-finding the equivalent control afterwards is
  // what makes Enter-to-open usable: without it, opening a day drops you at the
  // top of the page and you have to tab all the way back in.
  const refocus = (selector) => {
    const next = el.querySelector(selector);
    if (next) next.focus();
  };

  el.addEventListener("click", (ev) => {
    const state = getState();
    const act = ev.target.closest("button[data-cal-act]");
    if (act) {
      const what = act.dataset.calAct;
      if (what === "close-day") { onChange({ ...state, selected: null }); return; }
      if (what === "retry" && handlers.onRetry) { handlers.onRetry(null); return; }
      if (what === "runs-retry" && handlers.onRetry) { handlers.onRetry(act.dataset.task); return; }
      return;
    }
    const viewBtn = ev.target.closest("button[data-view]");
    if (viewBtn) {
      const next = viewBtn.dataset.view;
      onChange({ ...state, view: next, selected: null });
      refocus(`button[data-view="${next}"]`);
      return;
    }
    const nav = ev.target.closest("button[data-step]");
    if (nav) {
      const n = Number(nav.dataset.step);
      if (state.view === "week") {
        onChange({ ...state, anchor: addDays(state.anchor, n * 7), selected: null });
      } else {
        const { year, month } = stepMonth(state.year, state.month, n);
        // Focus follows the page, so the next Tab lands inside the month on
        // screen rather than on a date that is no longer drawn.
        onChange({ ...state, year, month, selected: null, focus: toKey(year, month, 1) });
      }
      refocus(`button[data-step="${nav.dataset.step}"]`);
      return;
    }
    const cell = ev.target.closest("button[data-day]");
    if (cell) {
      const key = cell.dataset.day;
      onChange({ ...state, selected: state.selected === key ? null : key, focus: key });
      refocus(`button[data-day="${key}"]`);
    }
  });

  el.addEventListener("keydown", (ev) => {
    // Only the grid and the week rows navigate by arrow. The agenda's day
    // headings are also button[data-day], and swallowing ArrowDown there would
    // stop the page scrolling to reach the list the heading belongs to.
    const cell = ev.target.closest && ev.target.closest("button.cal-cell[data-day], button.cal-wrow[data-day]");
    if (!cell) return;
    const action = KEY_ACTIONS[ev.key];
    if (!action) return;
    ev.preventDefault();
    const state = getState();
    const next = stepFocus(cell.dataset.day, action);
    const p = parseKey(next);
    if (!p) return;
    onChange({ ...state, focus: next, year: p.y, month: p.m, anchor: next });
    refocus(`button[data-day="${next}"]`);
  });
}

// The state a fresh panel starts in: agenda view, this month, nothing selected.
export function initialCalendarState(today) {
  const p = parseKey(today) || { y: 2026, m: 1 };
  return { view: "agenda", year: p.y, month: p.m, anchor: today, selected: null, focus: today };
}

// How many times each rule fires in the next `days` - used by the manage list to
// say "8 more times this year" rather than only "next 2026-10-10".
export function countUpcoming(rule, today, days = 365) {
  return occurrencesBetween(rule, today, addDays(today, days), 200).length;
}
