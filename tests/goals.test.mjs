// Budgets/goals are a single keyed source. Editing a goal must be readable
// everywhere via goalValue/resolveDietTargets, and an explicit goal must win
// over the scaffold-derived diet targets.

import assert from "node:assert";
import { GOALS, goalDef, goalValue, goalDisplayValue, resolveDietTargets, activeProteinTarget } from "../src/domain/goals.js";

// Catalog integrity: unique kinds, valid periods, a default each.
{
  const kinds = GOALS.map((g) => g.kind);
  assert.equal(new Set(kinds).size, kinds.length, "goal kinds are unique");
  for (const g of GOALS) {
    assert.ok(["daily", "weekly", "monthly"].includes(g.period), `${g.kind} valid period`);
    assert.ok(g.default > 0, `${g.kind} has a default`);
    assert.ok(g.label && g.domain, `${g.kind} labelled + domained`);
  }
  assert.ok(goalDef("daily_protein"), "lookup by kind works");
  assert.equal(goalDef("nonsense"), null);
}

// goalValue reads from the keyed budgets array.
{
  const budgets = [
    { kind: "monthly_spend", amount: 40000 },
    { kind: "daily_protein", amount: 180 },
  ];
  assert.equal(goalValue(budgets, "monthly_spend"), 40000);
  assert.equal(goalValue(budgets, "daily_protein"), 180);
  assert.equal(goalValue(budgets, "weekly_spend"), null, "unset goal -> null");
  // display falls back to the seed default when unset
  assert.equal(goalDisplayValue(budgets, "monthly_spend"), 40000);
  assert.equal(goalDisplayValue(budgets, "weekly_spend"), goalDef("weekly_spend").default);
}

// resolveDietTargets: an explicit goal OVERRIDES the scaffold target.
{
  const scaffold = { calories: 1765, protein_g: 151, carbs_g: 153, fat_g: 67 };
  // no goals -> scaffold passes through
  const t0 = resolveDietTargets([], scaffold);
  assert.equal(t0.calories, 1765);
  assert.equal(t0.protein_g, 151);
  // set a protein goal -> it wins, calories still scaffold
  const t1 = resolveDietTargets([{ kind: "daily_protein", amount: 200 }], scaffold);
  assert.equal(t1.protein_g, 200, "explicit protein goal overrides scaffold");
  assert.equal(t1.calories, 1765, "calories untouched");
  // set both
  const t2 = resolveDietTargets([
    { kind: "daily_protein", amount: 190 },
    { kind: "daily_calories", amount: 2200 },
  ], scaffold);
  assert.equal(t2.protein_g, 190);
  assert.equal(t2.calories, 2200);
  // activeProteinTarget mirrors the same precedence
  assert.equal(activeProteinTarget([{ kind: "daily_protein", amount: 175 }], 151), 175);
  assert.equal(activeProteinTarget([], 151), 151, "falls back to scaffold");
}

console.log("goals.test.mjs: all assertions passed");
