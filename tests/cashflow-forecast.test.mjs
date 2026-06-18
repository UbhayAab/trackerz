import assert from "node:assert/strict";
import { safeToSpendToday, projectMonthEndSpend, simulateDiscretionaryCut } from "../src/analytics/cashflow-forecast.js";

const today = new Date("2026-06-15T12:00:00"); // mid-June: 30-day month, day 15
const ledger = [
  { direction: "expense", amount: 5000, is_discretionary: true, occurred_at: "2026-06-10T10:00:00" },
  { direction: "expense", amount: 4000, is_discretionary: false, occurred_at: "2026-06-12T10:00:00" },
  { direction: "income", amount: 50000, occurred_at: "2026-06-01T10:00:00" }, // ignored
];
const budgets = [{ period: "monthly", category_id: null, amount: 30000 }];
const subscriptions = [{ merchant: "Netflix", median_amount: 500, next_expected_at: "2026-06-20T10:00:00" }];

const safe = safeToSpendToday({ ledger, budgets, subscriptions, today });
assert.equal(safe.monthlyCap, 30000);
assert.equal(safe.spent, 9000, "income must be excluded; only June expenses counted");
assert.equal(safe.upcoming, 500, "subscription due later this month counts as upcoming");
assert.equal(safe.remaining, 20500);
assert.equal(safe.daysLeft, 16); // 30 - 15 + 1
assert.equal(safe.perDay, Math.round(20500 / 16));
assert.equal(safe.hasBudget, true);

// No budget → hasBudget false, perDay 0.
assert.equal(safeToSpendToday({ ledger, budgets: [], today }).hasBudget, false);

// Projection at current pace.
const proj = projectMonthEndSpend({ ledger, today });
assert.equal(proj.spent, 9000);
assert.equal(proj.projected, Math.round((9000 / 15) * 30)); // 18000

// What-if: halving discretionary pace saves money vs baseline.
const whatIf = simulateDiscretionaryCut({ ledger, today, reduceFraction: 0.5 });
assert.ok(whatIf.projected < whatIf.baseline, "cutting discretionary spend should lower projection");
assert.ok(whatIf.saved > 0);

console.log("cashflow-forecast tests passed");
