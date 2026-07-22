// Shared rules for the alert/insight surfaces. Pure, no DOM, no fetching.

import { GOALS } from "../domain/goals.js";

export function getInsightSeverity({ pace = 1, confidence = 1 }) {
  if (confidence < 0.72) return "review";
  if (pace > 1.25) return "risk";
  if (pace < 0.85) return "good";
  return "watch";
}

// Money caps and diet/gym targets share ONE `budgets` table keyed by `kind`, so
// anything that compares rupee spend against a budget row MUST filter first.
// Without this, a `daily_calories` target of 2300 was read as a ₹2300 daily cap
// and fired "budget exceeded" money alerts off the user's food logging — the
// alert engine has no idea the number is kilocalories.
//
// Listed non-money kinds are excluded; anything unrecognised (including legacy
// rows written before `kind` existed, which were always rupee caps) stays in,
// so an unknown kind can never silently swallow a real spend alert.
const NON_MONEY_GOAL_KINDS = new Set(
  GOALS.filter((goal) => goal.domain !== "money").map((goal) => goal.kind),
);

export function isMoneyBudget(budget) {
  const kind = budget?.kind;
  if (!kind) return true;
  return !NON_MONEY_GOAL_KINDS.has(kind);
}

export function moneyBudgetsOnly(budgets = []) {
  return budgets.filter(isMoneyBudget);
}
