// Rolling averages for body_metrics rows where metric_type = 'weight'.
// We bucket measurements by local calendar date (keeping the latest reading
// per day) so that twice-daily weigh-ins don't double-count. Returns a list
// sorted oldest -> newest with 7- and 14-day trailing means.

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

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Number((sum / values.length).toFixed(3));
}

export function rollingWeightAverages(rows) {
  const weights = (rows || [])
    .filter((r) => r.metric_type === "weight")
    .map((r) => ({ at: toDate(r.occurred_at), value: Number(r.value) }))
    .filter((r) => r.at && Number.isFinite(r.value))
    .sort((a, b) => a.at - b.at);

  // Latest reading per local day.
  const perDay = new Map();
  for (const r of weights) {
    perDay.set(localDateKey(r.at), r);
  }
  const ordered = [...perDay.values()].sort((a, b) => a.at - b.at);

  const series = ordered.map((row, idx) => {
    const window7 = ordered.slice(Math.max(0, idx - 6), idx + 1).map((r) => r.value);
    const window14 = ordered.slice(Math.max(0, idx - 13), idx + 1).map((r) => r.value);
    return {
      date: localDateKey(row.at),
      value: Number(row.value.toFixed(3)),
      avg7: average(window7),
      avg14: average(window14),
    };
  });

  const latest = series[series.length - 1] || null;
  return {
    series,
    latestAvg7: latest ? latest.avg7 : null,
    latestAvg14: latest ? latest.avg14 : null,
  };
}

export default rollingWeightAverages;
