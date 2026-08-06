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
// and fired "budget exceeded" money alerts off the user's food logging - the
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

// ---------------------------------------------------------------------------
// Behavioural patterns -> insight rows.
//
// Takes the OBSERVATIONS from lib/pattern-engine.mjs as plain data. Deliberately
// no import: the engine pulls in the whole food table and the fan-out expander,
// and this file is loaded by every analytics page in a repo with no bundler.
//
// The boundary this function enforces, and the only reason it is not a one-line
// map: an observation is a description of what happened, and `actionable` here
// means "may offer the user a plan change", nothing more. A pattern that is an
// ADDITION - four Saturdays of pizza while lunch is unchanged - is real, worth
// showing, and must never turn into a plan edit. Only a proven REPLACEMENT, or
// something the user actually said, gets that far, and even then it travels the
// normal confirm gate. If detected behaviour were allowed to rewrite the plan,
// the plan would converge on behaviour, adherence would read 100% forever and
// the tracker would be measuring nothing. The gap is the product.
export function patternInsight(observation) {
  if (!observation || !observation.evidence) return null;
  // An observation with no confidence is a MALFORMED observation, not a
  // zero-confidence one. Defaulting it to 0 would render it as "measured, and
  // measured badly" and colour a card off a number nobody computed; dropping it
  // is the only honest handling. Every real observation carries a tier.
  const confidence = typeof observation.confidence?.value === "number" ? observation.confidence.value : null;
  if (confidence === null) return null;
  return {
    id: observation.id,
    domain: observation.domain,
    title: observation.item,
    // The evidence string always carries its own counts ("4 of the last 5
    // Saturdays"), so a rendered card can never claim more than was measured.
    detail: observation.evidence,
    when: observation.weekdayName || (observation.kind === "daily" ? "most days" : null),
    at: observation.hour?.at || null,
    confidence,
    // pace is 1 for a pattern: it is not a budget overrun, and feeding it a made
    // up pace would colour the card red for no measured reason.
    severity: getInsightSeverity({ pace: 1, confidence }),
    actionable: observation.proposesPlanChange === true,
  };
}

export function patternInsights(observations = []) {
  return observations.map(patternInsight).filter(Boolean);
}
