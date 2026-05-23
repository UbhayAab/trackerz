// Summarises step counts over a 7-day window from body_metrics rows
// (metric_type = 'steps').

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function computeStepSummary(bodyMetrics = [], target = 7000) {
  const now = Date.now();
  const start = now - 7 * DAY_MS;

  const perDay = new Map();
  for (const m of bodyMetrics) {
    if (m.metric_type !== "steps") continue;
    const t = new Date(m.occurred_at).getTime();
    if (Number.isNaN(t) || t < start || t > now + DAY_MS) continue;
    const key = dayKey(m.occurred_at);
    perDay.set(key, (perDay.get(key) || 0) + Number(m.value || 0));
  }

  // Build a 7-day series including zero-fill days.
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    daily.push({ date: key, steps: Math.round(perDay.get(key) || 0) });
  }

  const present = daily.filter((d) => d.steps > 0);
  const avg = present.length
    ? Math.round(present.reduce((a, b) => a + b.steps, 0) / present.length)
    : 0;
  const hitDays = daily.filter((d) => d.steps >= target).length;
  const missedDays = daily.filter((d) => d.steps < target).length;

  return { daily, avg, hitDays, missedDays };
}
