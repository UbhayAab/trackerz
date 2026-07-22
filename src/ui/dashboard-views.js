// Renders Day/Week/Month dashboards into the Dashboard page.
// Reads state passed in; never fetches Supabase itself.

import { aggregatePeriods, dailySeries } from "../analytics/period-aggregator.js";
import { composeInsights } from "../analytics/insights-feed.js";

function fmt(n, { currency = false } = {}) {
  if (n === null || n === undefined) return "-";
  if (currency) return `₹${Math.round(n).toLocaleString("en-IN")}`;
  return Math.round(n).toLocaleString("en-IN");
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

export function renderDashboards({ ledger = [], foodLogs = [], wellnessLogs = [], bodyMetrics = [], budgets = [], subscriptions = [], today = new Date() } = {}) {
  const root = document.getElementById("dashboardViews");
  if (!root) return;
  const agg = aggregatePeriods({ ledger, foodLogs, wellnessLogs, bodyMetrics, today });
  const insights = composeInsights({ aggregates: agg, budgets, subscriptions, ledger, today });
  const series = dailySeries({ rows: ledger.filter((r) => r.direction === "expense"), today, days: 30, valueOf: (r) => Math.abs(Number(r.amount || 0)) });

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
      ${tile("Sleep (avg)", `${fmt(agg.today.sleepHoursAvg)}h`)}
    </div>
    <div class="dashboard-view" data-view="week" hidden>
      ${tile("Week spend",  fmt(agg.week.spend, { currency: true }),        fmtDelta(agg.deltas.wow_spend),     deltaClass(agg.deltas.wow_spend))}
      ${tile("Prev week",   fmt(agg.prev_week.spend, { currency: true }))}
      ${tile("Avg protein", `${fmt(agg.week.protein / 7)}g`)}
      ${tile("Meals",       fmt(agg.week.mealCount))}
      ${tile("Steps total", fmt(agg.week.steps))}
      ${tile("Sleep avg",   `${fmt(agg.week.sleepHoursAvg)}h`)}
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
    <div class="sparkline-wrap">
      <h3>30-day spend</h3>
      <svg viewBox="0 0 300 60" class="sparkline" preserveAspectRatio="none" aria-label="30-day spend sparkline">
        ${renderSparkline(series)}
      </svg>
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
  return `<polyline fill="none" stroke="#138a5b" stroke-width="2" points="${points}" /><polygon fill="rgba(19,138,91,0.12)" points="${points} ${(series.length - 1) * stepX},60 0,60"/>`;
}
