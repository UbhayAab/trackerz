// Finds simple co-occurrence based mood triggers over the last `days` days.
// Scans wellness_logs for "low mood" days (mood_score <= 4) and tallies how
// often a candidate trigger (food delivery count, high spend, poor sleep, late
// food) also fell on those days vs the baseline.

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function inWindow(value, startMs, endMs) {
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && t >= startMs && t <= endMs;
}

function score(lowDaysWith, lowDaysTotal, allDaysWith, allDaysTotal) {
  if (!lowDaysTotal || !allDaysTotal) return 0;
  const lowRate = lowDaysWith / lowDaysTotal;
  const baseRate = allDaysWith / allDaysTotal;
  // Co-occurrence lift bounded to [0,1].
  const lift = lowRate - baseRate;
  return Number(Math.max(0, Math.min(1, lift)).toFixed(3));
}

export function findMoodTriggers({
  wellnessLogs = [],
  foodLogs = [],
  ledger = [],
  days = 14,
} = {}) {
  const now = Date.now();
  const start = now - days * DAY_MS;

  // Collect the universe of days present in any source within the window.
  const allDays = new Set();
  for (const w of wellnessLogs) {
    if (inWindow(w.occurred_at, start, now)) allDays.add(dayKey(w.occurred_at));
  }
  for (const f of foodLogs) {
    if (inWindow(f.occurred_at, start, now)) allDays.add(dayKey(f.occurred_at));
  }
  for (const l of ledger) {
    if (inWindow(l.occurred_at, start, now)) allDays.add(dayKey(l.occurred_at));
  }

  if (!allDays.size) return [];

  // Low-mood days = any wellness_log with mood_score <= 4 in window.
  const lowDays = new Set();
  for (const w of wellnessLogs) {
    if (!inWindow(w.occurred_at, start, now)) continue;
    if (w.mood_score != null && Number(w.mood_score) <= 4) {
      lowDays.add(dayKey(w.occurred_at));
    }
  }

  // Trigger 1: >=3 food deliveries that day.
  const deliveriesByDay = new Map();
  for (const f of foodLogs) {
    if (!inWindow(f.occurred_at, start, now)) continue;
    const text = `${f.description || ""} ${f.meal_name || ""}`.toLowerCase();
    if (/(swiggy|zomato|delivery|delivered|uber eats|dominos|kfc|mcdonald)/.test(text)) {
      const key = dayKey(f.occurred_at);
      deliveriesByDay.set(key, (deliveriesByDay.get(key) || 0) + 1);
    }
  }
  const heavyDeliveryDays = new Set(
    [...deliveriesByDay.entries()].filter(([, n]) => n >= 3).map(([d]) => d),
  );

  // Trigger 2: poor sleep day (< 6h) preceding low mood.
  // For simplicity, sleep_hours rows themselves are not in this function;
  // instead we look at wellnessLogs.note for "slept poorly"/"insomnia" tags.
  const poorSleepDays = new Set();
  for (const w of wellnessLogs) {
    if (!inWindow(w.occurred_at, start, now)) continue;
    const text = String(w.note || "").toLowerCase();
    if (/(slept poorly|insomnia|no sleep|bad sleep|barely slept|tired)/.test(text)) {
      poorSleepDays.add(dayKey(w.occurred_at));
    }
  }

  // Trigger 3: high spend day (top-quartile spend within window).
  const spendByDay = new Map();
  for (const l of ledger) {
    if (l.direction !== "expense") continue;
    if (!inWindow(l.occurred_at, start, now)) continue;
    const key = dayKey(l.occurred_at);
    spendByDay.set(key, (spendByDay.get(key) || 0) + Math.abs(Number(l.amount || 0)));
  }
  const sortedSpend = [...spendByDay.values()].sort((a, b) => b - a);
  const q1Index = Math.floor(sortedSpend.length / 4);
  const highSpendThreshold = sortedSpend.length ? sortedSpend[q1Index] || 0 : Infinity;
  const highSpendDays = new Set(
    [...spendByDay.entries()]
      .filter(([, v]) => v >= highSpendThreshold && v > 0)
      .map(([d]) => d),
  );

  // Trigger 4: late-night eating (any food log between 22:00 and 03:00 UTC).
  const lateEatDays = new Set();
  for (const f of foodLogs) {
    if (!inWindow(f.occurred_at, start, now)) continue;
    const d = new Date(f.occurred_at);
    const hour = d.getUTCHours();
    if (hour >= 22 || hour < 3) lateEatDays.add(dayKey(f.occurred_at));
  }

  const triggers = [
    {
      trigger: "low mood days correlate with ≥3 food deliveries",
      set: heavyDeliveryDays,
    },
    {
      trigger: "low mood days correlate with poor-sleep notes",
      set: poorSleepDays,
    },
    {
      trigger: "low mood days correlate with high-spend days",
      set: highSpendDays,
    },
    {
      trigger: "low mood days correlate with late-night eating",
      set: lateEatDays,
    },
  ];

  const allDaysList = [...allDays];
  const lowDaysList = [...lowDays];

  const out = [];
  for (const t of triggers) {
    const sampleDays = lowDaysList.filter((d) => t.set.has(d));
    const allWith = allDaysList.filter((d) => t.set.has(d)).length;
    const s = score(sampleDays.length, lowDaysList.length, allWith, allDaysList.length);
    if (s > 0 && sampleDays.length > 0) {
      out.push({
        trigger: t.trigger,
        score: s,
        sample_days: sampleDays,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
