import { $ } from "../utils/dom.js";
import { inr } from "../utils/formatters.js";

export function renderMetrics(state) {
  setText("#todaySpend", inr(state.metrics.todaySpend), `Budget pace ${inr(state.metrics.budgetPace)}`);
  setText("#proteinMetric", `${state.metrics.protein}g`, `Target ${state.metrics.proteinTarget}g`);
  setText("#habitScore", String(state.metrics.habitScore), state.metrics.habitNote);
  setText("#reviewCount", String(state.reviewRows.length));
  setText("#reviewRisk", `${state.reviewRows.filter((row) => row.risk !== "none").length} risk`);
  setText("#caloriesLeft", "500", "Target 2,100");
  setText("#adherenceMetric", "78", "Photo + voice evidence");
}

function setText(selector, value, siblingText = null) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.textContent = value;
  if (siblingText && element.nextElementSibling) element.nextElementSibling.textContent = siblingText;
}
