// Compute a single day's eating window from food_logs.
// `lateNightSnack` flags any meal after 22:30 local time (using the row's
// own local clock - we parse the ISO string and pull the local hour/minute
// from a Date object).

const LATE_HOUR = 22;
const LATE_MINUTE = 30;

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isLateNight(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (h > LATE_HOUR) return true;
  if (h === LATE_HOUR && m >= LATE_MINUTE) return true;
  return false;
}

export function computeEatingWindow(foodLogs) {
  const dates = (foodLogs || [])
    .map((r) => toDate(r.occurred_at))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!dates.length) {
    return {
      firstMealAt: null,
      lastMealAt: null,
      windowHours: 0,
      lateNightSnack: false,
      mealCount: 0,
    };
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const windowHours = (last.getTime() - first.getTime()) / 3_600_000;
  const lateNightSnack = dates.some(isLateNight);

  return {
    firstMealAt: first.toISOString(),
    lastMealAt: last.toISOString(),
    windowHours: Number(windowHours.toFixed(2)),
    lateNightSnack,
    mealCount: dates.length,
  };
}

export default computeEatingWindow;
