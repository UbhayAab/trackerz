// Standalone node:assert test for the pure money-insights engine.
// Run with `node tests/money-insights.test.mjs`.

import assert from "node:assert/strict";

import {
  isSpend,
  classifyDescription,
  groupKey,
  categoryBreakdown,
  biggestRecurring,
  monthForecast,
  discretionarySplit,
  upcomingSubscriptions,
  whereToCut,
  buildMoneyInsights,
} from "../lib/money-insights.mjs";

let n = 0;
function eq(a, b, m) { assert.equal(a, b, m); n += 1; }
function ok(a, m) { assert.ok(a, m); n += 1; }
function close(a, b, tol, m) { assert.ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ~${b})`); n += 1; }

// --- isSpend: exclusions -----------------------------------------------------
eq(isSpend({ direction: "expense", amount: 100 }), true, "expense is spend");
eq(isSpend({ direction: "income", amount: 100 }), false, "income is not spend");
eq(isSpend({ direction: "transfer", amount: 100 }), false, "transfer is not spend");
eq(isSpend({ direction: "expense", amount: 100, merged_into: "x" }), false, "merged duplicate excluded");
eq(isSpend(null), false, "null row is not spend");

// --- classification ----------------------------------------------------------
eq(classifyDescription("egg curry rotis rice"), "Food", "egg curry -> Food");
eq(classifyDescription("HP petrol pump"), "Fuel", "petrol -> Fuel");
eq(classifyDescription("uber ride home"), "Transport", "uber -> Transport");
eq(classifyDescription("random gibberish xyz"), null, "no keyword -> null (no guessing)");
eq(classifyDescription(""), null, "empty -> null");

// merchant wins over description; blank merchant falls back to keywords.
eq(groupKey({ merchant: "Netflix", description: "egg" }), "Netflix", "merchant wins");
eq(groupKey({ merchant: "", description: "egg curry" }), "Food", "blank merchant -> keyword category");
eq(groupKey({ merchant: null, description: "zzz" }), "Other", "unclassifiable -> Other");

// --- category breakdown ------------------------------------------------------
const ledger = [
  { id: "l1", direction: "expense", amount: 110, merchant: "", description: "egg curry lunch", is_discretionary: true, occurred_at: "2026-07-01T13:00:00+05:30" },
  { id: "l2", direction: "expense", amount: 110, merchant: "", description: "rotis rice eggs lunch", is_discretionary: true, occurred_at: "2026-07-04T13:00:00+05:30" },
  { id: "l3", direction: "expense", amount: 112, merchant: "", description: "egg lunch", is_discretionary: true, occurred_at: "2026-07-08T13:00:00+05:30" },
  { id: "l4", direction: "expense", amount: 108, merchant: "", description: "lunch eggs", is_discretionary: true, occurred_at: "2026-07-11T13:00:00+05:30" },
  { id: "f1", direction: "expense", amount: 1103, merchant: "", description: "HP petrol fuel", is_discretionary: false, occurred_at: "2026-07-05T09:00:00+05:30" },
  { id: "t1", direction: "transfer", amount: 5000, merchant: "Self", description: "to savings", occurred_at: "2026-07-06T09:00:00+05:30" },
  { id: "d1", direction: "expense", amount: 200, merchant: "Zomato", description: "dinner", is_discretionary: true, merged_into: "l1", occurred_at: "2026-07-06T20:00:00+05:30" },
  { id: "i1", direction: "income", amount: 40000, merchant: "Salary", description: "pay", occurred_at: "2026-07-01T00:00:00+05:30" },
];

const bd = categoryBreakdown(ledger);
eq(bd.count, 5, "5 spend rows counted (transfer/income/merged excluded)");
eq(bd.total, 110 + 110 + 112 + 108 + 1103, "total excludes transfer/income/merged");
eq(bd.groups[0].label, "Fuel", "Fuel is the biggest single category");
eq(bd.groups[0].count, 1, "Fuel has 1 row");
close(bd.groups[0].pct, 1103 / 1543, 0.001, "Fuel pct correct");
const food = bd.groups.find((g) => g.label === "Food");
eq(food.count, 4, "Food folds all 4 lunches");

// empty
eq(categoryBreakdown([]).total, 0, "empty breakdown total 0");
eq(categoryBreakdown([{ direction: "income", amount: 5 }]).groups.length, 0, "no spend -> no groups");

// --- biggest recurring -------------------------------------------------------
const rec = biggestRecurring(ledger);
ok(rec, "recurring detected");
eq(rec.label, "Food", "recurring is the lunch (Food)");
eq(rec.count, 4, "4 lunches clustered");
close(rec.medianAmount, 110, 2, "median ~110");
ok(rec.perWeek >= 2 && rec.perWeek <= 4, "perWeek in sane range for 4 in ~10 days");
ok(rec.weeklyCost > 0 && rec.monthlyCost > rec.weeklyCost, "weekly/monthly cost derived");
eq(biggestRecurring([{ id: "a", direction: "expense", amount: 50, description: "x" }]), null, "too few rows -> null");

// A single-day burst gets no fabricated per-week rate.
const burst = [
  { id: "b1", direction: "expense", amount: 100, merchant: "Cafe", occurred_at: "2026-07-10T09:00:00+05:30" },
  { id: "b2", direction: "expense", amount: 100, merchant: "Cafe", occurred_at: "2026-07-10T12:00:00+05:30" },
  { id: "b3", direction: "expense", amount: 100, merchant: "Cafe", occurred_at: "2026-07-10T18:00:00+05:30" },
];
const burstRec = biggestRecurring(burst);
ok(burstRec, "burst still surfaced as recurring");
eq(burstRec.perWeek, null, "no per-week rate fabricated from a 1-day span");

// --- month forecast ----------------------------------------------------------
const today = new Date("2026-07-12T18:00:00+05:30");
const fcNoCap = monthForecast(ledger, [], today);
eq(fcNoCap.hasCap, false, "no monthly cap -> hasCap false");
ok(fcNoCap.projected > 0, "projection still computed from real spend");
eq(fcNoCap.cap, null, "cap is null, not 0");

const fcCap = monthForecast(ledger, [{ kind: "monthly_spend", amount: 5000, period: "monthly" }], today);
eq(fcCap.hasCap, true, "cap present");
eq(fcCap.cap, 5000, "cap amount read");
ok(typeof fcCap.onTrack === "boolean", "onTrack computed against cap");
close(fcCap.projected, Math.round((1543 / 12) * 31), 2, "projection = pace * daysInMonth");

// A zero/blank cap is treated as unset, never as a real cap of 0.
eq(monthForecast(ledger, [{ kind: "monthly_spend", amount: 0 }], today).hasCap, false, "cap of 0 is unset");

// No spend at all in the month -> projected null, not 0.
eq(monthForecast([], [], today).projected, null, "no spend -> projected null");

// --- discretionary split -----------------------------------------------------
const split = discretionarySplit(ledger);
ok(split, "split computed");
eq(split.discretionary, 440, "discretionary = 4 lunches");
eq(split.essential, 1103, "essential = fuel");
eq(split.unknown, 0, "no unknown here");
close(split.discretionaryRatio, 440 / 1543, 0.001, "ratio over classified spend");
eq(discretionarySplit([]), null, "empty -> null split");

// unknown bucket kept separate
const splitUnknown = discretionarySplit([
  { id: "u", direction: "expense", amount: 300, description: "x" },
  { id: "e", direction: "expense", amount: 100, is_discretionary: false, description: "y" },
]);
eq(splitUnknown.unknown, 300, "unknown discretionary kept separate");
eq(splitUnknown.discretionaryRatio, 0, "ratio over classified only (0 discretionary)");

// --- upcoming subscriptions --------------------------------------------------
const subs = [
  { merchant: "Netflix", median_amount: 649, next_expected_at: "2026-07-20T00:00:00+05:30", cadence_days: 30, is_active: true },
  { merchant: "Spotify", median_amount: 119, next_expected_at: "2026-09-01T00:00:00+05:30", is_active: true },
  { merchant: "OldGym", median_amount: 1000, next_expected_at: "2026-07-25T00:00:00+05:30", is_active: false },
];
const up = upcomingSubscriptions(subs, today);
eq(up.length, 1, "only Netflix is due within 30 days and active");
eq(up[0].merchant, "Netflix", "Netflix surfaced");
eq(up[0].amount, 649, "amount carried");
ok(up[0].daysAway >= 7 && up[0].daysAway <= 9, "daysAway computed");
eq(upcomingSubscriptions([], today).length, 0, "no subs -> empty");

// --- where to cut ------------------------------------------------------------
const cut = whereToCut(ledger);
ok(cut, "cut suggestion produced");
eq(cut.label, "Food", "top discretionary category is Food");
eq(cut.amount, 440, "cut amount = discretionary Food total");
eq(cut.halfSaving, 220, "half saving computed");
eq(whereToCut([{ id: "e", direction: "expense", amount: 100, is_discretionary: false }]), null, "no discretionary -> null cut");

// --- top-level ---------------------------------------------------------------
const all = buildMoneyInsights({ ledger, budgets: [{ kind: "monthly_spend", amount: 5000 }], subscriptions: subs, today });
eq(all.empty, false, "not empty with spend");
eq(all.spendRowCount, 5, "5 spend rows");
ok(all.breakdown && all.recurring && all.forecast && all.split && all.cut, "all sections present");
eq(buildMoneyInsights({ ledger: [], today }).empty, true, "no rows -> empty");
eq(buildMoneyInsights({}).empty, true, "no input -> empty (no crash)");

console.log(`money-insights tests passed: ${n} assertions`);
