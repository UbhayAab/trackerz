import { inr } from "../utils/formatters.js";

// The ONE metric renderer. Every figure here comes from state.metrics, which
// sync.js derives from the single source (budget goals -> resolveDietTargets).
// No page hardcodes a target — change a goal and every number below moves.
export function renderMetrics(state) {
  const m = state.metrics || {};
  const protein = Math.round(Number(m.protein) || 0);
  const proteinTarget = Math.round(Number(m.proteinTarget) || 0);
  const caloriesTarget = Math.round(Number(m.caloriesTarget) || 0);
  const caloriesLeft = Math.round(Number(m.caloriesLeft) || 0);
  const proteinGap = Math.max(0, proteinTarget - protein);

  // Home glance: today's spend.
  setText("#todaySpend", inr(m.todaySpend), "so far today");

  // Diet-page metric cards (no-op on pages that lack these ids).
  setText("#caloriesLeft", String(caloriesLeft), caloriesTarget ? `Target ${caloriesTarget.toLocaleString("en-IN")}` : "Calories left");
  setText("#proteinMetric", `${protein}g`, proteinTarget ? `Target ${proteinTarget}g` : "Protein");
  setText("#adherenceMetric", String(m.adherence ?? 0), "Photo + voice evidence");

  // Diet-page summary rail tiles (all from the same numbers as above).
  setText("#summaryCaloriesLeft", String(caloriesLeft));
  setText("#summaryDietProtein", `${protein} / ${proteinTarget}g`);
  setText("#summaryMealRows", String(m.mealsToday ?? 0));
  setText("#summaryProteinGap", `${proteinGap}g`);
}

function setText(selector, value, siblingText = null) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.textContent = value;
  if (siblingText && element.nextElementSibling) element.nextElementSibling.textContent = siblingText;
}
