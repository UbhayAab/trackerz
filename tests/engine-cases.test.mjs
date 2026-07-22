// ENGINE CASE MATRIX - drives the whole deterministic layer (router + intent +
// fan-out/salvage + sanity) over a large corpus of real, messy, mixed captures
// and checks the routing of EVERY one. This is the "every case handled" guard.
import assert from "node:assert/strict";
import { expandToolCalls } from "../lib/fan-out-expander.mjs";
import { sanityCheck } from "../lib/sanity-guards.mjs";
import { classifyRequestKind } from "../lib/request-router.mjs";

const NOW = "2026-06-29T12:00:00+05:30";
const review = () => [{ name: "request_user_review", arguments: { reason: "domain unclear" }, confidence: 0.5 }];
const synth = (evidence, seed = review()) => expandToolCalls(seed, { evidence, now: NOW });
const names = (r) => r.map((t) => t.name);
const hasName = (r, n) => names(r).includes(n);

// expectation helpers
const EXP = "create_expense_candidate", FOOD = "create_food_log_candidate", WORK = "create_workout_log_candidate";

// [evidence, { expense, food, workout }] - true=must exist, false=must NOT exist.
const CASES = [
  // --- eat vs buy vs made (cost decides the money side) ---
  ["bought paneer and cheese for 50 rupees", { expense: true, food: false }],
  ["made paneer sabzi which costed me 50 rupees", { expense: true, food: true }],
  ["just made paneer sabzi", { expense: false, food: true }],
  ["spent 120 for mushroom sandwich and rose milk", { expense: true, food: true }],
  ["groceries for the week - paneer and rice, paid 800", { expense: true, food: false }],
  ["picked up 2kg curd and bread for the fridge", { food: false }], // grocery -> no meal
  ["had dal and 2 rotis for lunch", { expense: false, food: true }],
  ["paid 250 at zomato for lunch", { expense: true, food: true }],
  ["ordered lunch from swiggy, paid 250", { expense: true, food: true }],
  ["spent 2000 on fuel", { expense: true, food: false }],

  // --- gym detection / salvage ---
  ["did Workout A, bench 3x10 60kg then leg press 2x12", { workout: true }],
  ["ran 5k this morning", { workout: true }],
  ["walked 35 min", { workout: true }],
  ["worked out, did chest press and a brisk walk", { workout: true }], // the drift case
  ["spent 1200 on a grocery run at dmart", { workout: false, food: false, expense: true }], // "grocery run" is not a workout

  // --- commands: change the scaffolding, log NOTHING ---
  ["change my gym schedule today: bench 3x10 60kg, squats 3x8", { workout: false, food: false }],
  ["for the next 4 Mondays I'll have paneer salad", { food: false }],
  ["make Thursdays a rest day", { workout: false }],
  ["adjust my calorie budget to 1800", { expense: false, food: false }],
  ["raise my protein goal to 180", { expense: false, food: false }],
  ["set my spend cap to 40000", { expense: false }],
  ["how much did I spend on food this month", { expense: false, food: false, workout: false }],

  // --- mixed: a command that ALSO logs keeps the log half ---
  ["change my plan to PPL, also I ate dal and 2 rotis for lunch", { food: true }],

  // --- wellness / non-loggable by the salvage layer ---
  ["slept 7 hours", { expense: false, food: false, workout: false }],
];

for (const [evidence, expect] of CASES) {
  const r = synth(evidence);
  if ("expense" in expect) assert.equal(hasName(r, EXP), expect.expense, `EXPENSE for ${JSON.stringify(evidence)} -> got ${JSON.stringify(names(r))}`);
  if ("food" in expect) assert.equal(hasName(r, FOOD), expect.food, `FOOD for ${JSON.stringify(evidence)} -> got ${JSON.stringify(names(r))}`);
  if ("workout" in expect) assert.equal(hasName(r, WORK), expect.workout, `WORKOUT for ${JSON.stringify(evidence)} -> got ${JSON.stringify(names(r))}`);
}

// --- commands never leave a synthesized write behind (review stays, no create_) ---
for (const cmd of ["change my gym schedule today", "raise my protein goal", "how much did I spend"]) {
  const r = synth(cmd);
  assert.equal(r.some((t) => String(t.name).startsWith("create_")), false, `command "${cmd}" must synthesize no writes`);
  assert.notEqual(classifyRequestKind(cmd), "log", `"${cmd}" should not classify as a log`);
}

// --- backdating rides through onto the synthesized rows ---
{
  const r = synth("had maggi and tomato rice yesterday night");
  const food = r.find((t) => t.name === FOOD);
  assert.ok(food, "yesterday food logs");
  assert.equal(food.arguments.occurred_at, "2026-06-28T21:00:00+05:30", "backdated to yesterday night");
}

// --- sanity flags the implausible salvaged/emitted values (tag, never block) ---
const sanityCases = [
  ["create_expense_candidate", { amount: 540000, occurred_at: NOW }, "amount_too_large"],
  ["create_food_log_candidate", { description: "x", calories_estimate: 50000, occurred_at: NOW }, "calories_implausible"],
  ["create_body_metric_candidate", { metric_type: "weight", value: 600, occurred_at: NOW }, "weight_out_of_range"],
  ["create_expense_candidate", { amount: 250, occurred_at: "2031-01-01T00:00:00+05:30" }, "future_date"],
];
for (const [tool, args, flag] of sanityCases) {
  const s = sanityCheck(tool, args, NOW);
  assert.equal(s.ok, false);
  assert.ok(s.flags.includes(flag), `${tool} should flag ${flag}, got ${JSON.stringify(s.flags)}`);
}
// plausible values never flag (no false-positive fatigue)
for (const [tool, args] of [
  ["create_expense_candidate", { amount: 250, occurred_at: NOW }],
  ["create_food_log_candidate", { description: "thali", calories_estimate: 800, protein_g: 35, occurred_at: NOW }],
  ["create_body_metric_candidate", { metric_type: "weight", value: 84, occurred_at: NOW }],
]) {
  assert.equal(sanityCheck(tool, args, NOW).ok, true, `${tool} plausible value must not flag`);
}

console.log(`engine-cases tests passed: ${CASES.length} routing cases + commands + backdate + sanity`);
