// Renders the ranked cross-domain insights from lib/analytics-insights.mjs as
// clean, severity-coloured cards. DOM only - no data logic, no fetching.

import { buildInsights } from "../../lib/analytics-insights.mjs";
import { activeProteinTarget, activeCalorieTarget } from "../domain/goals.js";

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const DOMAIN_LABEL = { diet: "Diet", money: "Money", gym: "Gym", body: "Body", sleep: "Sleep" };

function card(ins) {
  return `
    <article class="insight-card sev-${escapeHtml(ins.severity)}">
      <div class="insight-card-head">
        <span class="insight-domain">${escapeHtml(DOMAIN_LABEL[ins.domain] || ins.domain)}</span>
        <span class="insight-sev-dot" aria-hidden="true"></span>
      </div>
      <p class="insight-headline">${escapeHtml(ins.headline)}</p>
      ${ins.detail ? `<p class="insight-detail">${escapeHtml(ins.detail)}</p>` : ""}
      ${ins.evidence ? `<p class="insight-evidence"><span class="ev-tag">from</span> ${escapeHtml(ins.evidence)}</p>` : ""}
    </article>
  `;
}

/**
 * Render insight cards into a container element (by id).
 * Accepts the raw state slices; targets resolve from budgets via goals.js.
 */
export function renderInsightCards({
  mountId = "insightCards",
  ledger = [], foodLogs = [], workoutLogs = [], bodyMetrics = [],
  sleepSessions = [], budgets = [], today = new Date(),
} = {}) {
  const root = document.getElementById(mountId);
  if (!root) return;

  let result;
  try {
    result = buildInsights({
      ledger, foodLogs, workoutLogs, bodyMetrics, sleepSessions, budgets, today,
      proteinTarget: activeProteinTarget(budgets),
      calorieTarget: activeCalorieTarget(budgets),
    });
  } catch (err) {
    // A failed computation must look different from an empty dataset.
    root.innerHTML = `<div class="insight-cards-error" role="alert">Couldn't build insights: ${escapeHtml(err && err.message || err)}</div>`;
    return;
  }

  if (result.empty || !result.insights.length) {
    root.innerHTML = `<p class="insight-cards-empty muted small">${escapeHtml(result.reason || "No insights yet.")}</p>`;
    return;
  }
  root.innerHTML = result.insights.map(card).join("");
}

export default { renderInsightCards };
