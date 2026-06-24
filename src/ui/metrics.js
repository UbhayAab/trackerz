import { $ } from "../utils/dom.js";
import { inr } from "../utils/formatters.js";

export function renderMetrics(state) {
  const m = state.metrics || {};
  // Home glance cards: spend, protein vs target, calories vs target.
  setText("#todaySpend", inr(m.todaySpend), "so far today");
  // Protein/Calories live in the diet hub's scales (driven by today's food logs),
  // so they're no longer duplicated as glance cards here.
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
