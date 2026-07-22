// CURATED CAPTURE CASES — the subtle routing calls the combinatorial matrix
// can't express. Same scope as labeller-matrix: the DETERMINISTIC net (the LLM
// does primary routing). Where a case's money/date is only recoverable by the
// model (no explicit cue), the comment says so and we assert what IS deterministic.
import assert from "node:assert/strict";
import { expandToolCalls, looksLikeFood, looksLikePurchase, extractAmount } from "../lib/fan-out-expander.mjs";
import { looksLikeGym } from "../lib/capture-intent.mjs";
import { isChangeRequest, carriesLoggedEvent } from "../lib/request-router.mjs";

const NOW = "2026-06-30T12:00:00+05:30";
const route = (ev) => expandToolCalls([], { evidence: ev, now: NOW }).map((t) => t.name);
const has = (names, tool) => names.includes(tool);

let n = 0;
const A = (cond, msg) => { assert.ok(cond, msg); n += 1; };

// Each case asserts only the keys it lists.
function check(ev, exp) {
  const names = route(ev);
  if ("food" in exp) A(has(names, "create_food_log_candidate") === exp.food, `${JSON.stringify(ev)} food=${exp.food}`);
  if ("expense" in exp) A(has(names, "create_expense_candidate") === exp.expense, `${JSON.stringify(ev)} expense=${exp.expense}`);
  if ("workout" in exp) A(has(names, "create_workout_log_candidate") === exp.workout, `${JSON.stringify(ev)} workout=${exp.workout}`);
  if ("purchase" in exp) A(looksLikePurchase(ev) === exp.purchase, `${JSON.stringify(ev)} purchase=${exp.purchase}`);
  if ("command" in exp) A(isChangeRequest(ev) === exp.command, `${JSON.stringify(ev)} command=${exp.command}`);
  if ("gym" in exp) A(looksLikeGym(ev) === exp.gym, `${JSON.stringify(ev)} gym=${exp.gym}`);
  if ("food_word" in exp) A(looksLikeFood(ev) === exp.food_word, `${JSON.stringify(ev)} looksLikeFood=${exp.food_word}`);
  if ("amount" in exp) A(extractAmount(ev) === exp.amount, `${JSON.stringify(ev)} amount=${exp.amount}`);
}

const CASES = [
  // --- numbers that are NOT money (the classic false-positive trap) ---
  ["walked 10000 steps", { expense: false, workout: true, amount: null }],
  ["did 15000 steps today", { expense: false, workout: true }],
  ["weight 72 kg", { expense: false, workout: false, food: false, amount: null }],
  ["slept 7 hours", { expense: false, workout: false, food: false, amount: null }],
  ["drank 500 ml water", { expense: false, workout: false, food: false, amount: null }],
  ["2000 calories today", { expense: false, amount: null }],
  ["heart rate 72 bpm", { expense: false, amount: null }],
  ["bench 3x10 60kg", { expense: false, workout: true, amount: null }],
  ["ran for 45 minutes", { expense: false, workout: true }],
  ["72 kg bodyweight", { amount: null, expense: false }],

  // --- amount extraction robustness (only explicit money cues) ---
  ["spent 250 on dal", { amount: 250, expense: true, food: true }],
  ["paid rs 250", { amount: 250, expense: true }],
  ["Rs.250 debited from account", { amount: 250, expense: true }],
  ["₹1,250 at the store", { amount: 1250, expense: true }],
  // "lunch" names WHEN, not WHAT — no dish, so no macros are derivable. We used
  // to synthesize a food row anyway, which showed up in production as a blank
  // "lunch (auto from spend)" meal with NULL calories/protein sitting next to the
  // real meal. It stays an expense only; looksLikeFood is still true (the word IS
  // a food cue), but namesDish is what gates row creation now.
  ["lunch - 120/-", { amount: 120, expense: true, food: false, food_word: true }],
  ["coffee 80 rs", { amount: 80, expense: true, food: true }],
  ["500", { amount: null, expense: false }],
  ["12000", { amount: null, expense: false }],

  // --- eat vs buy: the user's headline cases (offline: money is model-side) ---
  ["ate omelette for 70", { food: true, purchase: false, workout: false }], // model adds the ₹70 expense
  ["i ate an omelette", { food: true, expense: false }],
  ["bought paneer for 250", { purchase: true, food: false }], // model adds the ₹250 expense
  ["bought paneer, paid 250", { purchase: true, food: false, expense: true, amount: 250 }],
  ["made paneer sabzi", { food: true, expense: false }], // cooking = food log, no cost invented
  ["made paneer sabzi, cost 50", { food: true, expense: true, amount: 50 }],
  ["spent 500 on groceries and had dal", { purchase: false, food: true, expense: true, amount: 500 }], // "had" overrides purchase
  ["grocery run at dmart, spent 1200", { purchase: true, food: false, expense: true, amount: 1200 }],

  // --- screenshots: routing keys off the extracted evidence text ---
  ["zomato order paneer butter masala 2 naan total 480", { food_word: true, food: true }], // model extracts ₹480
  ["grocery bill from bigbasket bought milk eggs atta paid 640", { purchase: true, food: false, expense: true, amount: 640 }],

  // --- mixed multi-domain ---
  ["had dal rice and paid 120", { food: true, expense: true, amount: 120 }],
  ["did legs and had a shake", { workout: true, food: true }],
  ["gym done, spent 60 on a protein shake", { workout: true, food: true, expense: true, amount: 60 }],

  // --- plan vs log ---
  ["update my diet to salad at dinner", { command: true, food: false }], // "update my diet" is a plan cue
  ["had salad for dinner", { command: false, food: true }],
  ["swap leg day for cardio", { command: true, workout: false }],
  ["cardio instead of leg day", { command: true, workout: false }],
  ["did cardio today", { command: false, workout: true }],
  ["for the next 4 mondays paneer salad", { command: true, food: false }],
  ["make thursday a rest day", { command: true, workout: false }],
  ["from now on no maggi at night", { command: true, food: false }],

  // --- budget / target ---
  ["increase my calorie budget to 1800", { command: true, expense: false, food: false }],
  ["raise my protein goal to 180", { command: true }],
  ["set my spend cap to 40000", { command: true, expense: false }],

  // --- query ---
  ["how much did i spend on food", { command: true, expense: false, food: false }],
  ["am i on track with protein", { command: true }],
  ["what did i eat yesterday", { command: true, food: false }],

  // --- mixed command + explicit logged event (salvage allowed) ---
  ["change my plan, also i ate dal", { command: true, food: true }],
  ["update my diet and i had 2 rotis", { command: true, food: true }],

  // --- gibberish / empty ---
  ["asdkfjhaslkdjf", { food: false, expense: false, workout: false }],
  ["", { food: false, expense: false, workout: false }],
  ["   ", { food: false, expense: false, workout: false }],
];

for (const [ev, exp] of CASES) check(ev, exp);

// carriesLoggedEvent gate on the mixed cases
A(carriesLoggedEvent("change my plan, also i ate dal") === true, "mixed carries a logged event");
A(carriesLoggedEvent("change my gym schedule today") === false, "pure command carries nothing");

// --- backdating: the salvaged row lands on the right day ---
const expenseOn = (ev) => expandToolCalls([], { evidence: ev, now: NOW }).find((t) => t.name === "create_expense_candidate")?.arguments?.occurred_at?.slice(0, 10);
const foodOn = (ev) => expandToolCalls([], { evidence: ev, now: NOW }).find((t) => t.name === "create_food_log_candidate")?.arguments?.occurred_at?.slice(0, 10);
A(expenseOn("spent 250 on dal yesterday") === "2026-06-29", "yesterday's spend backdated");
A(foodOn("had biryani last night") === "2026-06-29", "last night's meal backdated");
A(expenseOn("paid 300 for lunch on 25 jun") === "2026-06-25", "explicit date honoured");

assert.ok(n >= 120, `expected 120+ curated assertions, ran ${n}`);
console.log(`capture-cases tests passed: ${n} assertions`);
