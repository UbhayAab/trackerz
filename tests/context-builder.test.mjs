import assert from "node:assert/strict";
import { buildContextBlock, expandUsualForDate } from "../lib/context-builder.mjs";

// (1) Hard char cap: a large input never exceeds maxChars.
const bigNotes = Array.from({ length: 50 }, (_, i) => ({
  kind: "todo",
  domain: "general",
  body: `note number ${i} with some longish body text to fill space`,
}));
const bigFacts = Array.from({ length: 50 }, (_, i) => ({
  key: `fact_${i}`,
  value: `value ${i}`,
  confidence: Math.random(),
}));
const bigLedger = Array.from({ length: 1000 }, () => ({ amount: 100, direction: "expense" }));
const bigBlock = buildContextBlock(
  {
    profile: { display_name: "Ubhay", timezone: "Asia/Kolkata", currency: "INR" },
    budgets: [{ kind: "monthly_spend", amount: 50000 }],
    notes: bigNotes,
    memoryFacts: bigFacts,
    recentLedger: bigLedger,
    recentFoodLogs: [{ calories_estimate: 500, protein_g: 40 }],
    recentWorkouts: [{}, {}],
    planToday: { summary: "leg day + high protein" },
  },
  { maxChars: 1800 },
);
assert.ok(bigBlock.length <= 1800, `block within cap (${bigBlock.length})`);

// (2) Priority truncation: tiny cap keeps PROFILE/TARGETS, drops PLAN_TODAY/LAST7.
const tiny = buildContextBlock(
  {
    profile: { display_name: "Ubhay", timezone: "Asia/Kolkata", currency: "INR" },
    budgets: [{ kind: "monthly_spend", amount: 50000 }],
    recentLedger: [{ amount: 240, direction: "expense" }],
    recentFoodLogs: [{ calories_estimate: 500, protein_g: 40 }],
    planToday: { summary: "leg day" },
  },
  { maxChars: 120 },
);
assert.ok(tiny.length <= 120, `tiny within cap (${tiny.length})`);
assert.ok(tiny.includes("PROFILE:"), "PROFILE survives");
assert.ok(tiny.includes("TARGETS:"), "TARGETS survives");
assert.ok(!tiny.includes("PLAN_TODAY:"), "PLAN_TODAY dropped under tiny cap");
assert.ok(!tiny.includes("LAST7:"), "LAST7 dropped under tiny cap");

// (3) Empty inputs -> no literal undefined/null/NaN.
const empty = buildContextBlock({});
assert.equal(typeof empty, "string");
assert.ok(!empty.includes("undefined"), "no undefined");
assert.ok(!empty.includes("null"), "no null");
assert.ok(!empty.includes("NaN"), "no NaN");

// (4) KNOWS capped at 12 and ordered by confidence desc.
const facts = Array.from({ length: 20 }, (_, i) => ({
  key: `k${i}`,
  value: `v${i}`,
  confidence: i / 20, // ascending; builder must re-sort desc
}));
const knowsBlock = buildContextBlock({ memoryFacts: facts }, { maxChars: 99999 });
const knowsLine = knowsBlock.split("\n").find((l) => l.startsWith("KNOWS:"));
assert.ok(knowsLine, "KNOWS line present");
const pairCount = (knowsLine.match(/="/g) || []).length;
assert.equal(pairCount, 12, "KNOWS capped at 12");
// Highest confidence (k19) first, lowest of the kept (k8) last.
assert.ok(knowsLine.indexOf('k19="') < knowsLine.indexOf('k18="'), "ordered by confidence desc");
assert.ok(knowsLine.includes('k8="'), "12th-highest kept");
assert.ok(!knowsLine.includes('k7="'), "13th-highest dropped");

// (5) LAST7 numbers correct, and identical for 10 vs 1000 rows (aggregation).
function makeInputs(n) {
  return {
    recentLedger: Array.from({ length: n }, () => ({ amount: 100, direction: "expense" })),
    recentFoodLogs: [
      { calories_estimate: 500, protein_g: 40 },
      { calories_estimate: 700, protein_g: 60 },
    ],
    recentWorkouts: [{}, {}, {}],
  };
}
const ten = buildContextBlock(makeInputs(10), { maxChars: 99999 });
const thousand = buildContextBlock(makeInputs(1000), { maxChars: 99999 });
const lastTen = ten.split("\n").find((l) => l.startsWith("LAST7:"));
const lastK = thousand.split("\n").find((l) => l.startsWith("LAST7:"));
// 2 meals: avg cal (500+700)/2=600, avg P (40+60)/2=50, 3 workouts.
assert.ok(lastTen.includes("2 meals avg 600 cal/50 P"), "meal aggregation correct");
assert.ok(lastTen.includes("3 workouts"), "workout count correct");
assert.ok(lastTen.includes("(10 txns)"), "10-row txn count");
assert.ok(lastK.includes("(1000 txns)"), "1000-row txn count");
// Same meal/workout aggregate regardless of ledger size.
assert.equal(
  lastTen.replace(/spent[^·]*·/, ""),
  lastK.replace(/spent[^·]*·/, ""),
  "meal+workout aggregate independent of history length",
);

// (6) expandUsualForDate: food per meal + workout, sharing group + occurred_at.
const occurredAt = "2026-06-25T08:00:00+05:30";
const gid = "evt-123";
const usual = expandUsualForDate({
  planForDateResult: {
    meals: [
      { name: "oats + whey", slot: "breakfast" },
      { name: "chicken rice", slot: "lunch" },
    ],
    workout: { description: "push day" },
  },
  occurredAt,
  eventGroupId: gid,
});
const foods = usual.filter((c) => c.name === "create_food_log_candidate");
const wos = usual.filter((c) => c.name === "create_workout_log_candidate");
assert.equal(foods.length, 2, "one food_log per meal");
assert.equal(wos.length, 1, "one workout_log");
for (const c of usual) {
  assert.equal(c.arguments.event_group_id, gid, "shares event_group_id");
  assert.equal(c.arguments.occurred_at, occurredAt, "shares occurred_at");
  assert.equal(c.arguments._auto_expanded, true, "_auto_expanded set");
  assert.ok(c.confidence > 0 && c.confidence < 1, "sane confidence");
}
assert.equal(foods[0].arguments.meal_slot, "breakfast", "meal_slot carried");

// Null plan -> [].
assert.deepEqual(expandUsualForDate({ planForDateResult: null, occurredAt, eventGroupId: gid }), []);
assert.deepEqual(expandUsualForDate({}), []);

console.log("context-builder tests passed");
