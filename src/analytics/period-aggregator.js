// Time-window aggregator for the Day/Week/Month dashboards.
// Pure: takes ledger / food_logs / wellness arrays + a "today" anchor, returns
// the shape the dashboard renderers consume.
//
// Buckets:
//   today      - 00:00 → now of `today`
//   yesterday  - full prior day
//   week       - last 7 calendar days incl. today
//   prev_week  - previous 7d block
//   month      - calendar month containing `today`
//   prev_month - prior calendar month
//
// For each bucket we emit { spend, income, mealCount, calories, protein, steps, sleepHours, moodAvg }.

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfMonth(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(1); return x; }

function rangeKey(name, start, end) {
  return { name, startISO: start.toISOString(), endISO: end.toISOString() };
}

function bucketsFor(today = new Date()) {
  const todayStart = startOfDay(today);
  const tomorrow = addDays(todayStart, 1);
  const ystart = addDays(todayStart, -1);
  const week = addDays(todayStart, -6);
  const prevWeek = addDays(todayStart, -13);
  const month = startOfMonth(todayStart);
  const prevMonthEnd = addDays(month, 0);
  const prevMonth = startOfMonth(addDays(month, -1));
  return {
    today: rangeKey("today", todayStart, tomorrow),
    yesterday: rangeKey("yesterday", ystart, todayStart),
    week: rangeKey("week", week, tomorrow),
    prev_week: rangeKey("prev_week", prevWeek, week),
    month: rangeKey("month", month, tomorrow),
    prev_month: rangeKey("prev_month", prevMonth, prevMonthEnd),
  };
}

function inRange(ts, range) {
  const t = new Date(ts).getTime();
  return t >= new Date(range.startISO).getTime() && t < new Date(range.endISO).getTime();
}

function summarize({ ledger = [], foodLogs = [], wellnessLogs = [], bodyMetrics = [], sleepSessions = [] }, range) {
  let spend = 0, income = 0, calories = 0, protein = 0, mealCount = 0;
  let steps = 0, stepDays = 0, sleepHours = 0, sleepCount = 0;
  let moodSum = 0, moodCount = 0;
  for (const r of ledger) {
    if (!inRange(r.occurred_at, range)) continue;
    const amt = Math.abs(Number(r.amount || 0));
    if (r.direction === "expense") spend += amt;
    else if (r.direction === "income") income += amt;
  }
  for (const m of foodLogs) {
    if (!inRange(m.occurred_at, range)) continue;
    mealCount += 1;
    calories += Number(m.calories_estimate || 0);
    protein += Number(m.protein_g || 0);
  }
  for (const w of wellnessLogs) {
    if (!inRange(w.occurred_at, range)) continue;
    if (typeof w.mood_score === "number") { moodSum += w.mood_score; moodCount += 1; }
  }
  for (const b of bodyMetrics) {
    if (!inRange(b.occurred_at, range)) continue;
    if (b.metric_type === "steps") { steps += Number(b.value || 0); stepDays += 1; }
    else if (b.metric_type === "sleep_hours") { sleepHours += Number(b.value || 0); sleepCount += 1; }
  }
  // Sleep from completed sessions - a night belongs to the day you WOKE. This is
  // the primary source; bodyMetrics sleep_hours is the legacy path above.
  for (const s of sleepSessions) {
    if (!s.started_at || !s.ended_at) continue;
    if (!inRange(s.ended_at, range)) continue;
    const h = (new Date(s.ended_at) - new Date(s.started_at)) / 3600000;
    if (h > 0 && h < 24) { sleepHours += h; sleepCount += 1; }
  }
  return {
    range,
    spend: Math.round(spend),
    income: Math.round(income),
    calories: Math.round(calories),
    protein: Math.round(protein),
    mealCount,
    // null, not 0, when nothing was measured. Steps and sleep have no manual
    // entry path yet (they come from the watch), so 0 always meant "no data" -
    // rendering it as a measured 0 is the exact trust bug this app keeps hitting.
    steps: stepDays ? steps : null,
    sleepHoursAvg: sleepCount ? Number((sleepHours / sleepCount).toFixed(1)) : null,
    moodAvg: moodCount ? Number((moodSum / moodCount).toFixed(2)) : null,
  };
}

function pctDelta(curr, prev) {
  if (!prev) return curr ? 1 : 0;
  return Number(((curr - prev) / prev).toFixed(3));
}

export function aggregatePeriods({ ledger = [], foodLogs = [], wellnessLogs = [], bodyMetrics = [], sleepSessions = [], today = new Date() } = {}) {
  const buckets = bucketsFor(today);
  const input = { ledger, foodLogs, wellnessLogs, bodyMetrics, sleepSessions };
  const today_ = summarize(input, buckets.today);
  const yesterday = summarize(input, buckets.yesterday);
  const week = summarize(input, buckets.week);
  const prevWeek = summarize(input, buckets.prev_week);
  const month = summarize(input, buckets.month);
  const prevMonth = summarize(input, buckets.prev_month);
  return {
    today: today_,
    yesterday,
    week,
    prev_week: prevWeek,
    month,
    prev_month: prevMonth,
    deltas: {
      dod_spend: pctDelta(today_.spend, yesterday.spend),
      wow_spend: pctDelta(week.spend, prevWeek.spend),
      mom_spend: pctDelta(month.spend, prevMonth.spend),
      dod_protein: pctDelta(today_.protein, yesterday.protein),
      wow_protein: pctDelta(week.protein, prevWeek.protein),
      dod_calories: pctDelta(today_.calories, yesterday.calories),
    },
  };
}

// Helper used by the dashboard UI: build a sparkline series of `days` length
// of the requested metric.
export function dailySeries({ rows = [], today = new Date(), days = 30, valueOf = () => 1 } = {}) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = addDays(startOfDay(today), -i);
    const dayEnd = addDays(dayStart, 1);
    const sum = rows.reduce((acc, r) => {
      const t = new Date(r.occurred_at).getTime();
      if (t >= dayStart.getTime() && t < dayEnd.getTime()) return acc + (Number(valueOf(r)) || 0);
      return acc;
    }, 0);
    out.push({ date: dayStart.toISOString().slice(0, 10), value: Math.round(sum) });
  }
  return out;
}
