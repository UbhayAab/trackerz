import { getFlowStats } from "../../lib/flow-catalog.mjs";
import { inr } from "../utils/formatters.js";

export function renderSummaryRail(state) {
  const moneyReviews = state.reviewRows.filter((row) => row.domain === "Money").length;
  const proteinGap = Math.max(0, state.metrics.proteinTarget - state.metrics.protein);

  setText("#summaryTodaySpend", inr(state.metrics.todaySpend));
  setText("#summaryReviewCount", String(state.reviewRows.length));
  setText("#summaryProtein", `${state.metrics.protein}g`);
  setText("#summaryHabitScore", String(state.metrics.habitScore));

  setText("#summaryMoneySpend", inr(state.metrics.todaySpend));
  setText("#summaryLedgerRows", String(state.ledgerRows.length));
  setText("#summaryImportRows", String(state.importRows.length));
  setText("#summaryMoneyReview", String(moneyReviews));

  setText("#summaryCaloriesLeft", String(state.metrics.caloriesLeft));
  setText("#summaryDietProtein", `${state.metrics.protein} / ${state.metrics.proteinTarget}g`);
  setText("#summaryMealRows", String(state.macroRows.length));
  setText("#summaryProteinGap", `${proteinGap}g`);

  setText("#summaryPendingReviews", String(state.reviewRows.length));
  setText("#summaryInsightCount", String(state.insights.length));
  setText("#summaryNightJob", "00:00");
  setText("#summaryFlowCoverage", `${getFlowStats().total} flows`);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}
