import { $ } from "../utils/dom.js";
import { inr } from "../utils/formatters.js";

export function renderMetrics(state) {
  const m = state.metrics || {};
  // Home glance cards: spend, protein vs target, calories vs target.
  setText("#todaySpend", inr(m.todaySpend), "so far today");
  setText("#proteinMetric", `${Math.round(m.protein || 0)}g`, `Target ${m.proteinTarget || 162}g`);
  setText("#caloriesMetric", `${Math.round(m.caloriesToday || 0)}`, "target 2,000 kcal");
  // Diet-page cards (these IDs don't exist on Home, so they no-op there).
  setText("#caloriesLeft", String(m.caloriesLeft ?? ""), "Target 2,000");
  setText("#adherenceMetric", String(m.adherence ?? ""), "Photo + voice evidence");
}

function setText(selector, value, siblingText = null) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.textContent = value;
  if (siblingText && element.nextElementSibling) element.nextElementSibling.textContent = siblingText;
}
