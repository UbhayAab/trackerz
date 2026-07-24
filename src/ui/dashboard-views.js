// Renders Day/Week/Month dashboards into the Dashboard page.
// Reads state passed in; never fetches Supabase itself.

import { aggregatePeriods, dailySeries } from "../analytics/period-aggregator.js";
import { composeInsights } from "../analytics/insights-feed.js";
import { activeProteinTarget, activeCalorieTarget } from "../domain/goals.js";

function fmt(n, { currency = false } = {}) {
  if (n === null || n === undefined) return "-";
  if (currency) return `₹${Math.round(n).toLocaleString("en-IN")}`;
  return Math.round(n).toLocaleString("en-IN");
}

// A value with a unit suffix that stays clean when the value is absent: renders
// "7.2h" with data, plain "-" (not "-h") without. This is what stops the
// analytics page reporting "Sleep 0h" for a night it never measured.
function fmtUnit(n, unit) {
  if (n === null || n === undefined) return "-";
  return `${Math.round(n * 10) / 10}${unit}`;
}

function fmtDelta(p) {
  if (p === null || p === undefined || !isFinite(p)) return "";
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "•";
  return ` ${arrow} ${Math.round(Math.abs(p) * 100)}%`;
}

function deltaClass(p) {
  if (p > 0) return "delta up";
  if (p < 0) return "delta down";
  return "delta flat";
}

export function renderDashboards({ ledger = [], foodLogs = [], wellnessLogs = [], bodyMetrics = [], sleepSessions = [], budgets = [], subscriptions = [], today = new Date() } = {}) {
  const root = document.getElementById("dashboardViews");
  if (!root) return;
  const agg = aggregatePeriods({ ledger, foodLogs, wellnessLogs, bodyMetrics, sleepSessions, today });
  const insights = composeInsights({ aggregates: agg, budgets, subscriptions, ledger, today });
  const series = dailySeries({ rows: ledger.filter((r) => r.direction === "expense"), today, days: 30, valueOf: (r) => Math.abs(Number(r.amount || 0)) });

  // Charts. Protein/calories are GAPPED (null on days with no food log) so we
  // never draw a flat zero line for a day we simply did not capture. Spend keeps
  // a real 0 baseline - a no-spend day is a measured fact, not missing data.
  const proteinTarget = activeProteinTarget(budgets);
  const calorieTarget = activeCalorieTarget(budgets);
  // valueOf returns null for a missing measurement so gappedSeries skips it -
  // a meal the AI never estimated must not sum in as a fake 0 kcal.
  const numOrNull = (v) => (v == null || !isFinite(Number(v)) ? null : Number(v));
  const proteinSeries = gappedSeries({ rows: foodLogs, today, days: 14, valueOf: (m) => numOrNull(m.protein_g), agg: "sum" });
  const calorieSeries = gappedSeries({ rows: foodLogs, today, days: 14, valueOf: (m) => numOrNull(m.calories_estimate), agg: "sum" });
  const weightRows = bodyMetrics.filter((b) => b.metric_type === "weight" && b.value != null);
  const weightSeries = gappedSeries({ rows: weightRows, today, days: 30, valueOf: (b) => numOrNull(b.value), agg: "last" });

  root.innerHTML = `
    <div class="dashboard-tabs" role="tablist">
      <button class="tab active" data-view="today" role="tab">Today</button>
      <button class="tab" data-view="week" role="tab">Week</button>
      <button class="tab" data-view="month" role="tab">Month</button>
    </div>
    <div class="dashboard-view" data-view="today">
      ${tile("Spend",       fmt(agg.today.spend, { currency: true }),       fmtDelta(agg.deltas.dod_spend),     deltaClass(agg.deltas.dod_spend))}
      ${tile("Protein",     `${fmt(agg.today.protein)}g`,                   fmtDelta(agg.deltas.dod_protein),   deltaClass(agg.deltas.dod_protein))}
      ${tile("Calories",    fmt(agg.today.calories),                        fmtDelta(agg.deltas.dod_calories),  deltaClass(agg.deltas.dod_calories))}
      ${tile("Meals",       fmt(agg.today.mealCount))}
      ${tile("Steps",       fmt(agg.today.steps))}
      ${tile("Sleep",       fmtUnit(agg.today.sleepHoursAvg, "h"))}
    </div>
    <div class="dashboard-view" data-view="week" hidden>
      ${tile("Week spend",  fmt(agg.week.spend, { currency: true }),        fmtDelta(agg.deltas.wow_spend),     deltaClass(agg.deltas.wow_spend))}
      ${tile("Prev week",   fmt(agg.prev_week.spend, { currency: true }))}
      ${tile("Avg protein", `${fmt(agg.week.protein / 7)}g`)}
      ${tile("Meals",       fmt(agg.week.mealCount))}
      ${tile("Steps total", fmt(agg.week.steps))}
      ${tile("Sleep avg",   fmtUnit(agg.week.sleepHoursAvg, "h"))}
    </div>
    <div class="dashboard-view" data-view="month" hidden>
      ${tile("Month spend", fmt(agg.month.spend, { currency: true }),       fmtDelta(agg.deltas.mom_spend),     deltaClass(agg.deltas.mom_spend))}
      ${tile("Prev month",  fmt(agg.prev_month.spend, { currency: true }))}
      ${tile("Income",      fmt(agg.month.income, { currency: true }))}
      ${tile("Net",         fmt(agg.month.income - agg.month.spend, { currency: true }))}
      ${tile("Meals",       fmt(agg.month.mealCount))}
      ${tile("Mood avg",    fmt(agg.month.moodAvg))}
    </div>
    <div class="insights-feed" aria-label="Insights">
      <h3>Insights</h3>
      ${insights.length
        ? `<ul>${insights.map((i) => `<li class="severity-${i.severity}"><span class="kind">${i.kind}</span>${i.text}</li>`).join("")}</ul>`
        : `<p class="muted small">No insights yet - drop a few captures and they will appear here.</p>`}
    </div>
    <div class="chart-grid">
      ${chartCard("Protein · last 14 days", "g", renderLineChart({ series: proteinSeries, target: proteinTarget, yFrom: "zero" }))}
      ${chartCard("Calories · last 14 days", "kcal", renderLineChart({ series: calorieSeries, target: calorieTarget, yFrom: "zero" }))}
      ${chartCard("Weight · last 30 days", "kg", renderLineChart({ series: weightSeries, target: null, yFrom: "auto" }))}
      <div class="chart-card sparkline-wrap">
        <h3>Spend · last 30 days</h3>
        ${series.some((p) => p.value > 0)
          ? `<svg viewBox="0 0 300 60" class="sparkline" preserveAspectRatio="none" aria-label="30-day spend sparkline">${renderSparkline(series)}</svg>`
          : `<p class="chart-empty muted small">No spend recorded in the last 30 days.</p>`}
      </div>
    </div>
  `;

  for (const tab of root.querySelectorAll(".dashboard-tabs .tab")) {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      root.querySelectorAll(".dashboard-tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
      root.querySelectorAll(".dashboard-view").forEach((v) => { v.hidden = v.dataset.view !== view; });
    });
  }
}

function tile(label, value, delta = "", deltaCls = "") {
  return `
    <article class="dashboard-tile">
      <p class="tile-label">${label}</p>
      <strong class="tile-value">${value}</strong>
      ${delta ? `<span class="${deltaCls}">${delta}</span>` : ""}
    </article>
  `;
}

function renderSparkline(series) {
  if (!series.length) return "";
  const max = Math.max(1, ...series.map((p) => p.value));
  const stepX = 300 / Math.max(1, series.length - 1);
  const points = series.map((p, i) => `${i * stepX},${60 - (p.value / max) * 56 - 2}`).join(" ");
  return `<polygon class="spark-fill" points="${points} ${(series.length - 1) * stepX},60 0,60"/><polyline class="spark-line" fill="none" stroke-width="2" points="${points}" />`;
}

// A daily series that GAPS empty days (value === null) instead of coercing them
// to 0. `agg` folds the rows landing in a day: "sum" (protein/calories), "avg",
// or "last" (weight - the reading you actually stepped on the scale for).
function gappedSeries({ rows = [], today = new Date(), days = 14, valueOf = () => 0, agg = "sum" } = {}) {
  const start = new Date(today); start.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date(start); dayStart.setDate(start.getDate() - i);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayStart.getDate() + 1);
    const hits = rows.filter((r) => {
      const t = new Date(r.occurred_at).getTime();
      return t >= dayStart.getTime() && t < dayEnd.getTime();
    });
    // Only rows that carry a real measurement count; a day where every row's
    // value is null stays a gap (null), never a fabricated 0.
    const vals = hits.map((r) => valueOf(r)).filter((v) => v != null && isFinite(Number(v))).map(Number);
    let value = null;
    if (vals.length) {
      if (agg === "last") value = vals[vals.length - 1];
      else {
        const sum = vals.reduce((a, v) => a + v, 0);
        value = agg === "avg" ? sum / vals.length : sum;
      }
      if (!isFinite(value)) value = null;
    }
    out.push({ date: dayStart.toISOString().slice(0, 10), value });
  }
  return out;
}

function chartCard(title, unit, body) {
  return `<div class="chart-card"><h3>${title}</h3>${body}</div>`;
}

// Hand-rolled, theme-aware SVG line chart. Gaps null values (breaks the line and
// dots only the days we actually have), optionally draws a dashed target line,
// and degrades to an explicit empty state rather than a fake flat line.
function renderLineChart({ series = [], target = null, yFrom = "zero" } = {}) {
  const pts = series.map((p, i) => ({ i, value: p.value }));
  const present = pts.filter((p) => p.value !== null && p.value !== undefined && isFinite(p.value));
  if (!present.length) {
    return `<p class="chart-empty muted small">No data yet - log a few days to see this.</p>`;
  }
  const n = series.length;
  const W = 300, H = 96, padL = 6, padR = 6, padT = 10, padB = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const values = present.map((p) => p.value);
  let yMax = Math.max(...values);
  let yMin = yFrom === "zero" ? 0 : Math.min(...values);
  if (target != null && isFinite(target)) { yMax = Math.max(yMax, target); if (yFrom !== "zero") yMin = Math.min(yMin, target); }
  if (yMax === yMin) yMax = yMin + 1; // avoid divide-by-zero on a single flat value
  const pad = (yMax - yMin) * 0.08;
  yMax += pad; if (yFrom !== "zero") yMin -= pad;

  const x = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Split into contiguous segments, breaking at gaps.
  const segments = [];
  let cur = [];
  for (const p of pts) {
    if (p.value === null || p.value === undefined || !isFinite(p.value)) {
      if (cur.length) { segments.push(cur); cur = []; }
    } else {
      cur.push(`${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`);
    }
  }
  if (cur.length) segments.push(cur);

  const lines = segments
    .map((s) => s.length === 1
      ? "" // a lone point is drawn as a dot below, no line
      : `<polyline class="chart-line" fill="none" stroke-width="2" points="${s.join(" ")}" />`)
    .join("");
  const dots = present
    .map((p) => `<circle class="chart-dot" cx="${x(p.i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2" />`)
    .join("");

  let targetEls = "";
  if (target != null && isFinite(target) && target >= yMin && target <= yMax) {
    const ty = y(target).toFixed(1);
    targetEls = `<line class="chart-target" x1="${padL}" y1="${ty}" x2="${W - padR}" y2="${ty}" stroke-dasharray="3 3" />`
      + `<text class="chart-target-label" x="${W - padR}" y="${Math.max(8, y(target) - 3).toFixed(1)}" text-anchor="end">target ${Math.round(target)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="line-chart" preserveAspectRatio="xMidYMid meet" role="img">${targetEls}${lines}${dots}</svg>`;
}
