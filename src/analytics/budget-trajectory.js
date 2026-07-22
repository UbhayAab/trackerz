export function projectMonthlySpend({ spentSoFar, dayOfMonth, daysInMonth = 30 }) {
  if (!dayOfMonth) return 0;
  return Math.round((spentSoFar / dayOfMonth) * daysInMonth);
}

export function getBudgetPace({ spentSoFar, budget, dayOfMonth, daysInMonth = 30 }) {
  const expected = (budget / daysInMonth) * dayOfMonth;
  return {
    expected: Math.round(expected),
    projected: projectMonthlySpend({ spentSoFar, dayOfMonth, daysInMonth }),
    pace: expected ? spentSoFar / expected : 0,
  };
}

// --- Period windows ---------------------------------------------------------
// THE single definition of a budget period. The Money page and the budget-alert
// engine used to each roll their own week: the page started weeks on ISO Monday
// while the alert engine started them on Sunday, so on a Sunday the same budget
// showed two different "spent so far" figures on two different screens. ISO
// Monday wins (it is what the rest of the app — plans, streaks — already uses).

// JS 0=Sun … 6=Sat -> ISO 1=Mon … 7=Sun.
function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysInMonthOf(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// `dayOfMonth` / `daysInMonth` are the generic "day into period / days in
// period" pair getBudgetPace consumes — the names are historical.
export function periodWindow(period, now = new Date()) {
  if (period === "daily") {
    const start = startOfDay(now);
    return { start, dayOfMonth: 1, daysInMonth: 1, since: (iso) => !!iso && new Date(iso) >= start };
  }
  if (period === "weekly") {
    const weekday = isoWeekday(now);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weekday - 1));
    return { start, dayOfMonth: weekday, daysInMonth: 7, since: (iso) => !!iso && new Date(iso) >= start };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    start,
    dayOfMonth: now.getDate(),
    daysInMonth: daysInMonthOf(now),
    since: (iso) => !!iso && new Date(iso) >= start,
  };
}

// The share of the period that has elapsed, used to judge "ahead of pace".
export function periodElapsedShare(period, now = new Date()) {
  const win = periodWindow(period, now);
  return Math.min(1, win.dayOfMonth / win.daysInMonth);
}

// --- Like-for-like month comparison ------------------------------------------
// Month-to-date was being compared against the FULL previous month, so on the
// 3rd of the month three days of spend beat thirty and the app congratulated
// the user on a ~90% "improvement" every single month. Compare the same number
// of elapsed days on both sides instead.
//
// Returns half-open [start, end) windows plus the day count each covers. When
// the previous month is shorter than the elapsed slice (31st of March vs
// February) the prior window is clamped and `comparable` goes false so the
// caller can soften or drop the claim rather than assert a bogus delta.
export function monthToDateWindows(today = new Date()) {
  const anchor = startOfDay(today);
  const elapsedDays = anchor.getDate();

  const currentStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const currentEnd = new Date(anchor.getFullYear(), anchor.getMonth(), elapsedDays + 1);

  const priorStart = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
  const priorDays = Math.min(elapsedDays, daysInMonthOf(priorStart));
  const priorEnd = new Date(priorStart.getFullYear(), priorStart.getMonth(), priorDays + 1);

  return {
    current: { start: currentStart, end: currentEnd, days: elapsedDays },
    prior: { start: priorStart, end: priorEnd, days: priorDays },
    comparable: priorDays === elapsedDays,
  };
}
