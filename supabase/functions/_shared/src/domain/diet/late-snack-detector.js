// Detect multi-day late-snack patterns from a long span of food_logs.
// "Late snack" = any meal after 22:30 local time. We bucket logs by local
// calendar date and surface every date that has at least one late snack, plus
// a streak summary so the caller can flag "5 nights in a row".

import { computeEatingWindow } from "./eating-window.js";

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function longestStreak(dateKeys) {
  if (!dateKeys.length) return 0;
  const sorted = [...dateKeys].sort();
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T00:00:00");
    const cur = new Date(sorted[i] + "T00:00:00");
    const days = Math.round((cur - prev) / 86_400_000);
    if (days === 1) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

export function detectLateSnackPattern(foodLogs) {
  const byDay = new Map();
  for (const row of foodLogs || []) {
    const at = toDate(row.occurred_at);
    if (!at) continue;
    const key = localDateKey(at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  const daysWithLateSnack = [];
  const dayBreakdown = [];
  for (const [dateKey, rows] of byDay.entries()) {
    const summary = computeEatingWindow(rows);
    dayBreakdown.push({ date: dateKey, ...summary });
    if (summary.lateNightSnack) daysWithLateSnack.push(dateKey);
  }
  daysWithLateSnack.sort();

  const totalDays = byDay.size;
  const lateCount = daysWithLateSnack.length;
  const ratio = totalDays ? lateCount / totalDays : 0;
  const streak = longestStreak(daysWithLateSnack);

  return {
    totalDays,
    daysWithLateSnack,
    lateNightDayCount: lateCount,
    ratio: Number(ratio.toFixed(3)),
    longestStreak: streak,
    isChronic: lateCount >= 3 && ratio >= 0.4,
    dayBreakdown: dayBreakdown.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export default detectLateSnackPattern;
