// THE CALENDAR - a month grid and an agenda, hand-rolled.
//
// WHY THERE IS NO SIXTH TAB, and no new page.
//
// A tab costs more than it looks: tests/navigation.test.mjs hard-asserts
// NAV_TABS.length === 5 and the exact id array, scripts/build-nav.mjs re-stamps
// every page from it, sw.js's APP_SHELL needs the new URL or the page is broken
// offline, and five tabs already barely fit a 320px phone. A calendar that costs
// the app its offline shell to reach is a bad trade.
//
// So this renders INTO the container that already exists: `#remindersStrip` on
// Home, the "Coming up" section. Home is where the user lands and where "what is
// coming" belongs; Settings keeps the manage list it already has. No HTML
// changes, no nav changes, no service-worker changes, and the calendar is one
// tap from the first screen instead of six.
//
// FullCalendar (~250 KB, bundles Preact) and Toast UI Calendar were rejected
// outright - this repo has no bundler, and lib/reminders.mjs already does the
// only hard part. A month is `firstWeekday` blanks plus `daysInMonth` cells in a
// CSS grid; an agenda is agendaBetween() piped into a list. That is ~200 lines.
//
// DOM only. No data fetching, no AI logic (tests/architecture.test.mjs).

import {
  agendaBetween, weekdayOf, addDays, daysInMonth, toKey, parseKey, compareKeys,
  describeRule, whenLabel, daysBetween, minutesOfDay, formatTime, occurrencesBetween,
} from "../../lib/reminders.mjs";

const WEEK_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export const KIND_ICON = {
  birthday: "🎂", anniversary: "💍", bill: "💸", filing: "🧾",
  appointment: "📅", task: "🔔", other: "🔔",
  // A check the APP runs on itself, not a bell it rings at you. Distinct glyph
  // rather than a colour, because a colour-only difference is invisible to a
  // colourblind reader and to a grayscale screenshot.
  agent: "🤖",
};

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// "Thu 14 Aug" - the agenda's day heading. Built from the key's own parts, never
// from a Date object, so it cannot shift by a zone.
export function dayHeading(key, today) {
  const p = parseKey(key);
  if (!p) return "";
  const away = daysBetween(today, key);
  if (away === 0) return "Today";
  if (away === 1) return "Tomorrow";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayOf(key)];
  return `${dow} ${p.d} ${MONTH_NAMES[p.m - 1].slice(0, 3)}`;
}

// The 42 cells of a month grid: leading blanks from the previous month, the
// month itself, then trailing blanks. Six rows always, so the grid does not
// resize as you page through months and push the rest of Home around.
export function monthCells(year, month, { marks = {}, today = null } = {}) {
  const first = toKey(year, month, 1);
  const lead = weekdayOf(first);
  const dim = daysInMonth(year, month);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ key: null, day: null, inMonth: false });
  for (let d = 1; d <= dim; d++) {
    const key = toKey(year, month, d);
    const items = marks[key] || [];
    cells.push({
      key, day: d, inMonth: true,
      count: items.length,
      isToday: key === today,
      isPast: today != null && compareKeys(key, today) < 0,
      kinds: [...new Set(items.map((r) => r.kind || "task"))],
    });
  }
  while (cells.length < 42) cells.push({ key: null, day: null, inMonth: false });
  return cells;
}

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// Step a (year, month) pair by n months. Integer arithmetic, like everything else.
export function stepMonth(year, month, n) {
  const idx = year * 12 + (month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

function timeChip(r) {
  const mins = minutesOfDay(r.at_time);
  return mins == null ? "" : `<span class="cal-time">${escapeHtml(formatTime(mins))}</span>`;
}

// ---- the agenda: what is coming, grouped by day -----------------------------

/**
 * `rows` are reminder RULES. Everything date-shaped is computed here from the
 * rules rather than stored, so the list and the engine that fires them cannot
 * disagree about a date the user is relying on.
 */
export function renderAgenda(rows, today, { days = 21, limitDays = 8 } = {}) {
  const to = addDays(today, days);
  const byDay = agendaBetween(rows || [], today, to);
  const keys = Object.keys(byDay).sort().slice(0, limitDays);
  if (!keys.length) {
    return `<p class="cal-empty">Nothing scheduled in the next ${days} days.</p>`;
  }
  return `<ul class="cal-agenda">${keys.map((key) => `
    <li class="cal-agenda-day${key === today ? " is-today" : ""}">
      <p class="cal-agenda-head">${escapeHtml(dayHeading(key, today))}<span class="cal-agenda-away">${escapeHtml(whenLabel(daysBetween(today, key)))}</span></p>
      <ul class="cal-agenda-items">
        ${byDay[key].map((r) => `
          <li class="cal-agenda-item" data-kind="${escapeHtml(r.kind || "task")}">
            <span class="cal-icon" aria-hidden="true">${KIND_ICON[r.kind] || "🔔"}</span>
            <span class="cal-title">${escapeHtml(r.title)}</span>
            ${timeChip(r)}
          </li>`).join("")}
      </ul>
    </li>`).join("")}</ul>`;
}

// ---- the month grid ---------------------------------------------------------

export function renderMonth(rows, { year, month, today, selected = null } = {}) {
  const first = toKey(year, month, 1);
  const last = toKey(year, month, daysInMonth(year, month));
  const marks = agendaBetween(rows || [], first, last);
  const cells = monthCells(year, month, { marks, today });

  const grid = cells.map((c) => {
    if (!c.inMonth) return `<span class="cal-cell is-blank" aria-hidden="true"></span>`;
    const cls = ["cal-cell"];
    if (c.isToday) cls.push("is-today");
    if (c.isPast) cls.push("is-past");
    if (c.count) cls.push("has-events");
    if (c.key === selected) cls.push("is-selected");
    // The dot count is capped at three: past that the number stops meaning
    // anything at 44px wide and starts overflowing the cell.
    const dots = c.count
      ? `<span class="cal-dots" aria-hidden="true">${"<i></i>".repeat(Math.min(3, c.count))}</span>`
      : "";
    const label = c.count === 1 ? "1 reminder" : `${c.count} reminders`;
    return `<button type="button" class="${cls.join(" ")}" data-day="${c.key}"
      aria-label="${escapeHtml(dayHeading(c.key, today))}${c.count ? `, ${label}` : ""}"
      ${c.key === selected ? 'aria-current="date"' : ""}>${c.day}${dots}</button>`;
  }).join("");

  const dayList = selected && marks[selected]
    ? `<ul class="cal-day-list">${marks[selected].map((r) => `
        <li class="cal-agenda-item">
          <span class="cal-icon" aria-hidden="true">${KIND_ICON[r.kind] || "🔔"}</span>
          <span class="cal-title">${escapeHtml(r.title)}</span>
          ${timeChip(r)}
          <small class="cal-rule">${escapeHtml(describeRule(r))}</small>
        </li>`).join("")}</ul>`
    : selected
      ? `<p class="cal-empty">Nothing on ${escapeHtml(dayHeading(selected, today))}.</p>`
      : "";

  return `
    <div class="cal-month">
      <div class="cal-month-head">
        <button type="button" class="cal-nav" data-step="-1" aria-label="Previous month">‹</button>
        <strong>${escapeHtml(monthLabel(year, month))}</strong>
        <button type="button" class="cal-nav" data-step="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-weekdays" aria-hidden="true">${WEEK_LETTERS.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-grid" role="grid">${grid}</div>
      ${dayList}
    </div>`;
}

// ---- the whole panel --------------------------------------------------------

/**
 * `state` = { view: "agenda" | "month", year, month, selected }.
 *
 * A read that FAILED renders as a failure, never as "nothing scheduled". That
 * distinction is the one this file most has to get right: a calendar showing an
 * empty month because the query errored is a calendar that has just told the
 * user they have no deadlines.
 */
export function renderCalendar(state, rows, today, { error = null, loaded = true } = {}) {
  if (error) {
    return `<p class="chips-error">Couldn't load your calendar: ${escapeHtml(error)}</p>`;
  }
  if (!loaded) return `<p class="muted">Loading calendar…</p>`;

  const view = state.view === "month" ? "month" : "agenda";
  const head = `
    <div class="cal-head">
      <p class="chips-label">Coming up</p>
      <div class="cal-toggle" role="group" aria-label="Calendar view">
        <button type="button" data-view="agenda" class="${view === "agenda" ? "is-on" : ""}" aria-pressed="${view === "agenda"}">Agenda</button>
        <button type="button" data-view="month" class="${view === "month" ? "is-on" : ""}" aria-pressed="${view === "month"}">Month</button>
      </div>
    </div>`;

  const body = view === "month"
    ? renderMonth(rows, { year: state.year, month: state.month, today, selected: state.selected })
    : renderAgenda(rows, today);

  return `${head}<div class="cal-body">${body}</div>`;
}

/**
 * Wire one container. `onChange(nextState)` is called with the new state and the
 * caller re-renders - no internal DOM mutation, so the render function stays the
 * single description of what the panel looks like.
 */
export function bindCalendar(el, getState, onChange) {
  if (!el || el.dataset.calBound === "1") return;
  el.dataset.calBound = "1";
  el.addEventListener("click", (ev) => {
    const state = getState();
    const viewBtn = ev.target.closest("button[data-view]");
    if (viewBtn) {
      onChange({ ...state, view: viewBtn.dataset.view, selected: null });
      return;
    }
    const nav = ev.target.closest("button[data-step]");
    if (nav) {
      const { year, month } = stepMonth(state.year, state.month, Number(nav.dataset.step));
      onChange({ ...state, year, month, selected: null });
      return;
    }
    const cell = ev.target.closest("button[data-day]");
    if (cell) {
      const key = cell.dataset.day;
      onChange({ ...state, selected: state.selected === key ? null : key });
    }
  });
}

// The state a fresh panel starts in: agenda view, this month, nothing selected.
export function initialCalendarState(today) {
  const p = parseKey(today) || { y: 2026, m: 1 };
  return { view: "agenda", year: p.y, month: p.m, selected: null };
}

// How many times each rule fires in the next `days` - used by the manage list to
// say "8 more times this year" rather than only "next 2026-10-10".
export function countUpcoming(rule, today, days = 365) {
  return occurrencesBetween(rule, today, addDays(today, days), 200).length;
}
