// Computes sleep debt over a 7-day window from body_metrics rows
// (metric_type = 'sleep_hours').

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function computeSleepDebt(bodyMetrics = [], targetHours = 8) {
  const now = Date.now();
  const start = now - 7 * DAY_MS;

  const perDay = new Map();
  for (const m of bodyMetrics) {
    if (m.metric_type !== "sleep_hours") continue;
    const t = new Date(m.occurred_at).getTime();
    if (Number.isNaN(t) || t < start || t > now + DAY_MS) continue;
    const key = dayKey(m.occurred_at);
    // Take the latest entry per day; sleep is typically logged once.
    perDay.set(key, Number(m.value || 0));
  }

  const entries = [...perDay.entries()];
  if (!entries.length) {
    return { debtHours: 0, dailyAvg: 0, worstNight: null };
  }

  const hours = entries.map(([, v]) => v);
  const dailyAvg = Number((hours.reduce((a, b) => a + b, 0) / hours.length).toFixed(2));
  const debtHours = Number(
    entries.reduce((acc, [, v]) => acc + Math.max(0, targetHours - v), 0).toFixed(2),
  );
  const worst = entries.reduce((acc, cur) => (acc == null || cur[1] < acc[1] ? cur : acc), null);
  const worstNight = worst ? { date: worst[0], hours: worst[1] } : null;

  return { debtHours, dailyAvg, worstNight };
}
