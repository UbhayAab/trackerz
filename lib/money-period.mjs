// Date navigation maths for the Money page: turn a (period, anchor day) pair
// into a half-open [start, end) window, a human label, and - the part that
// actually matters - an honest verdict on whether the rows we hold even COVER
// that window.
//
// The week definition is deliberately NOT here. Callers pass in the window
// object produced by periodWindow() in src/analytics/budget-trajectory.js,
// which is the app's single ISO-Monday definition; this module only derives the
// end bound from it (start + days-in-period) and builds presentation on top.
// A third week definition is how the app once showed two different "spent so
// far" figures for the same budget on two different screens.

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The period ids are budget-trajectory's own ("daily"/"weekly"/"monthly") so
// the same string can be handed straight to periodWindow.
export const PERIOD_UNIT = { daily: "day", weekly: "week", monthly: "month" };

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// periodWindow gives us `start` plus `daysInMonth` - which is really
// "days in this period" (1 / 7 / days-in-that-month). The exclusive end is
// therefore start + that many days, and calendar arithmetic keeps it right
// across DST and month lengths.
export function periodRange(win) {
  const start = new Date(win.start.getFullYear(), win.start.getMonth(), win.start.getDate());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + win.daysInMonth);
  return { start, end };
}

export function inRange(range, iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= range.start.getTime() && t < range.end.getTime();
}

// Step the anchor by whole periods. Monthly snaps to day 1 first so stepping
// back from the 31st lands on the previous month rather than spilling forward
// (new Date(2026, 1, 31) is 3 March).
export function stepAnchor(period, anchor, delta) {
  const d = startOfDay(anchor);
  if (period === "daily") d.setDate(d.getDate() + delta);
  else if (period === "weekly") d.setDate(d.getDate() + delta * 7);
  else d.setMonth(d.getMonth() + delta, 1);
  return d;
}

export function containsToday(range, today = new Date()) {
  const t = startOfDay(today).getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

// Built from fixed tables rather than toLocaleDateString so the label is
// identical in the browser and in tests, and never silently changes with the
// host's locale data.
export function periodLabel(period, range, today = new Date()) {
  const start = range.start;
  const last = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1);
  const sameYear = start.getFullYear() === startOfDay(today).getFullYear();
  const year = sameYear ? "" : ` ${start.getFullYear()}`;
  const now = containsToday(range, today);

  if (period === "daily") {
    const base = `${DAY_SHORT[start.getDay()]} ${start.getDate()} ${MONTH_SHORT[start.getMonth()]}${year}`;
    return now ? `Today · ${base}` : base;
  }
  if (period === "weekly") {
    const left = start.getMonth() === last.getMonth()
      ? `${start.getDate()}`
      : `${start.getDate()} ${MONTH_SHORT[start.getMonth()]}`;
    const base = `${left} - ${last.getDate()} ${MONTH_SHORT[last.getMonth()]}${year}`;
    return now ? `This week · ${base}` : base;
  }
  const base = `${MONTH_LONG[start.getMonth()]} ${start.getFullYear()}`;
  return now ? `This month · ${base}` : base;
}

// Short form for tile sub-labels, where "This month · July 2026" is too long.
export function periodShortLabel(period, range, today = new Date()) {
  const start = range.start;
  const last = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1);
  if (containsToday(range, today)) return `this ${PERIOD_UNIT[period] || "period"}`;
  if (period === "daily") return `${start.getDate()} ${MONTH_SHORT[start.getMonth()]}`;
  if (period === "weekly") return `${start.getDate()}-${last.getDate()} ${MONTH_SHORT[last.getMonth()]}`;
  return `${MONTH_SHORT[start.getMonth()]} ${start.getFullYear()}`;
}

// The ledger is fetched newest-first with a row cap, so stepping back far
// enough leaves the window OUTSIDE what we hold. Summing that to zero would
// assert "you spent nothing in March" when the truth is "we never fetched
// March". Verdicts:
//   full    - we hold every row that could fall in the window
//   partial - the window starts before our oldest row, so a total is a floor
//   none    - the whole window predates our oldest row; we know nothing
//   unknown - rows aren't an array (never read)
export function ledgerCoverage(rows, range, { limit }) {
  if (!Array.isArray(rows)) return "unknown";
  // Under the cap means the query returned everything there is.
  if (!limit || rows.length < limit) return "full";
  let oldest = Infinity;
  for (const row of rows) {
    const t = new Date(row?.occurred_at).getTime();
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  if (!Number.isFinite(oldest)) return "full";
  if (oldest <= range.start.getTime()) return "full";
  if (oldest < range.end.getTime()) return "partial";
  return "none";
}

export function sumExpenses(rows, range) {
  let total = 0;
  let count = 0;
  for (const row of rows || []) {
    if (row?.direction !== "expense") continue;
    if (!inRange(range, row.occurred_at)) continue;
    total += Number(row.amount) || 0;
    count += 1;
  }
  return { total, count };
}
