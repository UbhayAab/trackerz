import { $ } from "../utils/dom.js";
import { inr } from "../utils/formatters.js";

export function renderMetrics(state) {
  $("#todaySpend").textContent = inr(state.metrics.todaySpend);
  $("#todaySpend").nextElementSibling.textContent = `Budget pace ${inr(state.metrics.budgetPace)}`;
  $("#proteinMetric").textContent = `${state.metrics.protein}g`;
  $("#proteinMetric").nextElementSibling.textContent = `Target ${state.metrics.proteinTarget}g`;
  $("#habitScore").textContent = String(state.metrics.habitScore);
  $("#habitScore").nextElementSibling.textContent = state.metrics.habitNote;
  $("#reviewCount").textContent = String(state.reviewRows.length);
  $("#reviewRisk").textContent = `${state.reviewRows.filter((row) => row.risk !== "none").length} risk`;
}
