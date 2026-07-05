// Single source of truth for budgets + goals.
//
// Every budget/goal is a `kind`-keyed row in the `budgets` table. The editor
// writes by kind (upsert), and EVERY surface — Home glance, Money page, the diet
// hub's calorie/protein targets, the insight engine, the habit score — reads its
// value from here. Edit a budget once and it updates everywhere; there is no
// second hardcoded copy anywhere.
//
// Pure (no DOM/Supabase) so it's importable by UI + tests.

import { MACRO_TARGETS } from "./diet/plan.js";

// The canonical budget/goal catalog. `default` is the seed shown before the user
// sets one; `period` maps to the budgets.period check; `domain` groups the editor.
export const GOALS = [
  { kind: "monthly_spend", label: "Monthly spend cap", period: "monthly", domain: "money", unit: "₹", default: 45000 },
  { kind: "weekly_spend", label: "Weekly spend cap", period: "weekly", domain: "money", unit: "₹", default: 10500 },
  { kind: "food_cap", label: "Food delivery cap", period: "monthly", domain: "money", unit: "₹", default: 6500 },
  { kind: "daily_calories", label: "Daily calories", period: "daily", domain: "diet", unit: "kcal", default: MACRO_TARGETS.calories },
  { kind: "daily_protein", label: "Daily protein", period: "daily", domain: "diet", unit: "g", default: MACRO_TARGETS.protein_g },
  { kind: "weekly_calories", label: "Weekly calorie budget", period: "weekly", domain: "diet", unit: "kcal", default: MACRO_TARGETS.calories * 7 },
  { kind: "weekly_workouts", label: "Workouts per week", period: "weekly", domain: "gym", unit: "sessions", default: 4 },
];

const GOAL_BY_KIND = Object.fromEntries(GOALS.map((g) => [g.kind, g]));

export function goalDef(kind) {
  return GOAL_BY_KIND[kind] || null;
}

// The value set for a budget kind, or null if the user hasn't set one.
export function goalValue(budgets, kind) {
  const row = (budgets || []).find((b) => b.kind === kind);
  return row && row.amount != null ? Number(row.amount) : null;
}

// The value to SHOW in the editor input: the set value, else the seed default.
export function goalDisplayValue(budgets, kind) {
  const v = goalValue(budgets, kind);
  return v != null ? v : (goalDef(kind)?.default ?? null);
}

// Diet targets, single source. An explicit goal (daily_calories / daily_protein)
// wins; otherwise fall back to the scaffold-derived targets the plan computes;
// otherwise the constant. This is what makes "update the protein goal anywhere ->
// the diet gauges, Home, and insights all move".
export function resolveDietTargets(budgets, scaffoldTargets = {}) {
  const t = { ...MACRO_TARGETS, ...scaffoldTargets };
  const cal = goalValue(budgets, "daily_calories");
  const pro = goalValue(budgets, "daily_protein");
  if (cal != null) t.calories = cal;
  if (pro != null) t.protein_g = pro;
  return t;
}

export function activeProteinTarget(budgets, scaffoldTarget) {
  return goalValue(budgets, "daily_protein") ?? scaffoldTarget ?? MACRO_TARGETS.protein_g;
}
export function activeCalorieTarget(budgets, scaffoldTarget) {
  return goalValue(budgets, "daily_calories") ?? scaffoldTarget ?? MACRO_TARGETS.calories;
}

export default { GOALS, goalDef, goalValue, goalDisplayValue, resolveDietTargets, activeProteinTarget, activeCalorieTarget };
