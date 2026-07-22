// LABELLER MATRIX - 1000+ combinatorial cases over the DETERMINISTIC routing
// layer (lib/fan-out-expander.mjs + lib/capture-intent.mjs + lib/request-router.mjs).
//
// WHAT THIS TESTS: the deterministic salvage/fan-out net - the guarantees that
// hold WITHOUT the LLM. Primary routing is the DeepSeek brain (it turns "ate
// omelette for 70" into expense+food); this net catches food/spend/workout the
// model under-emits and suppresses logs for grocery purchases and change-commands.
// These are the invariants that must never regress. It asserts CONTRACT PROPERTIES
// (not a re-implementation), so it can't drift into tautology.
import assert from "node:assert/strict";
import {
  expandToolCalls, looksLikeFood, looksLikePurchase, extractAmount,
  mealSlotFromTime, resolveOccurredAt,
} from "../lib/fan-out-expander.mjs";
import { looksLikeGym } from "../lib/capture-intent.mjs";
import { isChangeRequest, carriesLoggedEvent, classifyRequestKind } from "../lib/request-router.mjs";

const NOW = "2026-06-30T12:00:00+05:30";
const route = (evidence) => expandToolCalls([], { evidence, now: NOW }).map((t) => t.name);
const has = (names, tool) => names.includes(tool);
const count = (names, tool) => names.filter((n) => n === tool).length;

let cases = 0;
let asserts = 0;
const A = (cond, msg) => { assert.ok(cond, msg); asserts += 1; };

// Foods that are all in FOOD_WORDS, so looksLikeFood is guaranteed true.
const FOODS = [
  "omelette", "dal", "rice", "paneer", "chicken", "dosa", "idli", "poha", "sandwich", "salad",
  "curd", "momo", "noodles", "pasta", "maggi", "banana", "apple", "upma", "paratha", "khichdi",
  "sambar", "vada", "pulao", "samosa", "pakora", "kheer", "tofu", "fish", "kebab", "tikka",
  "naan", "aloo", "palak", "rajma", "chole", "chana", "dahi", "muesli", "almonds", "peanuts",
  "shawarma", "chaat", "curry", "biryani", "roti", "soup",
];
const EAT_VERBS = ["ate", "had", "just ate", "have eaten", "had a"];
const TIMES = ["", " for breakfast", " this morning", " last night", " yesterday"];
const AMOUNTS = [70, 250, 1499];

// ---- INV: consumption ("ate X") -> food_log, never a purchase, no expense ----
for (const food of FOODS) {
  for (const verb of EAT_VERBS) {
    for (const time of TIMES) {
      const ev = `${verb} ${food}${time}`;
      cases += 1;
      A(looksLikeFood(ev), `looksLikeFood: ${ev}`);
      A(!looksLikePurchase(ev), `not a purchase (consumption cue): ${ev}`);
      A(!isChangeRequest(ev), `a log, not a command: ${ev}`);
      const names = route(ev);
      A(has(names, "create_food_log_candidate"), `food_log salvaged: ${ev}`);
      A(!has(names, "create_expense_candidate"), `no expense without a money cue: ${ev}`);
      A(!has(names, "create_workout_log_candidate"), `not a workout: ${ev}`);
    }
  }
}

// ---- INV: food + explicit money cue -> BOTH food_log AND expense ----
const MONEY_FOOD = [
  (f, n) => ({ ev: `spent ${n} on ${f}`, amt: n }),
  (f, n) => ({ ev: `paid ${n} for ${f}`, amt: n }),
  (f, n) => ({ ev: `${f} - ${n}`, amt: n }),
  (f, n) => ({ ev: `₹${n} ${f}`, amt: n }),
];
for (const food of FOODS) {
  for (const make of MONEY_FOOD) {
    const { ev, amt } = make(food, 250);
    cases += 1;
    A(!looksLikePurchase(ev), `discretionary food spend is not a grocery purchase: ${ev}`);
    A(extractAmount(ev) === amt, `amount extracted from: ${ev}`);
    const names = route(ev);
    A(has(names, "create_expense_candidate"), `expense present: ${ev}`);
    A(has(names, "create_food_log_candidate"), `food_log present: ${ev}`);
  }
}

// ---- INV: grocery PURCHASE suppresses the food_log ----
// with an extractable amount -> expense present, food absent
const BUY_WITH_AMOUNT = [
  (f, n) => `bought ${f}, spent ${n}`,
  (f, n) => `grocery run, paid ${n} for ${f}`,
  (f, n) => `stocked up on ${f}, ${n} rs`,
];
for (const food of FOODS) {
  for (const make of BUY_WITH_AMOUNT) {
    for (const n of AMOUNTS) {
      const ev = make(food, n);
      cases += 1;
      A(looksLikePurchase(ev), `is a purchase: ${ev}`);
      const names = route(ev);
      A(has(names, "create_expense_candidate"), `purchase still logs the spend: ${ev}`);
      A(!has(names, "create_food_log_candidate"), `bought != eaten -> no food_log: ${ev}`);
    }
  }
}
// without an extractable amount -> nothing salvaged (safe: model handles the spend)
for (const food of FOODS) {
  const ev = `bought ${food} for the week`;
  cases += 1;
  A(looksLikePurchase(ev), `for-the-week is a purchase: ${ev}`);
  const names = route(ev);
  A(!has(names, "create_food_log_candidate"), `no food_log for a grocery run: ${ev}`);
}

// ---- INV: gym free-text -> workout_log ----
const GYM = [
  "did legs", "leg day", "did chest", "did back", "did shoulders", "did arms",
  "hit the gym", "worked out", "session done", "did my workout", "lifted heavy",
  "bench 3x10 60kg", "squat 60kg 3x8", "leg press 2x12", "incline db press 2x10",
  "ohp 3x12", "plank 3x30s", "ran 5k", "walked 35 min", "brisk walk", "10k steps",
  "did workout a", "did workout b", "deadlift 3x5 80kg", "3x12",
];
for (const g of GYM) {
  cases += 1;
  A(looksLikeGym(g), `looksLikeGym: ${g}`);
  A(!isChangeRequest(g), `a workout log, not a command: ${g}`);
  const names = route(g);
  A(has(names, "create_workout_log_candidate"), `workout salvaged: ${g}`);
}

// ---- INV: change-commands & questions suppress ALL log salvage ----
const COMMANDS = [
  ["change my plan", "plan_change"], ["update my diet", "plan_change"],
  ["change my gym today", "plan_change"], ["swap my workout", "plan_change"],
  ["make it a rest day", "plan_change"], ["from now on no maggi", "plan_change"],
  ["for the next 4 mondays paneer salad", "plan_change"],
  ["raise my protein goal to 180", "budget_change"], ["set my spend cap to 40000", "budget_change"],
  ["increase my calorie budget to 1800", "budget_change"], ["lower my food budget", "budget_change"],
  ["change my target to 2000", "budget_change"],
  ["how much did i spend", "query"], ["am i on track", "query"], ["what's my protein", "query"],
  ["show me my summary", "query"], ["can i afford a phone", "query"],
];
for (const [ev, kind] of COMMANDS) {
  cases += 1;
  A(classifyRequestKind(ev) === kind, `classify ${JSON.stringify(ev)} -> ${kind}`);
  A(isChangeRequest(ev), `is a command: ${ev}`);
  A(!carriesLoggedEvent(ev), `carries no logged event: ${ev}`);
  const names = route(ev);
  A(!has(names, "create_expense_candidate"), `no expense for a command: ${ev}`);
  A(!has(names, "create_food_log_candidate"), `no food_log for a command: ${ev}`);
  A(!has(names, "create_workout_log_candidate"), `no workout for a command: ${ev}`);
}

// ---- fan-out: a model expense at a food merchant grows a food_log ----
{
  const out = expandToolCalls(
    [{ name: "create_expense_candidate", arguments: { merchant: "Zomato", description: "lunch", occurred_at: NOW }, confidence: 0.9 }],
    { evidence: "lunch from zomato", now: NOW },
  ).map((t) => t.name);
  cases += 1;
  A(has(out, "create_food_log_candidate"), "food-merchant expense fans out to a food_log");
  A(count(out, "create_expense_candidate") === 1, "the original expense is kept once");
}
// ...but a grocery purchase strips even a model-emitted food_log
{
  const out = expandToolCalls(
    [
      { name: "create_expense_candidate", arguments: { merchant: "Blinkit", occurred_at: NOW } },
      { name: "create_food_log_candidate", arguments: { occurred_at: NOW } },
    ],
    { evidence: "bought paneer from blinkit for the week", now: NOW },
  ).map((t) => t.name);
  cases += 1;
  A(!has(out, "create_food_log_candidate"), "purchase strips the food_log");
  A(has(out, "create_expense_candidate"), "purchase keeps the expense");
}

// ---- review request: dropped once something real is captured, kept for safety ----
{
  const dropped = expandToolCalls(
    [{ name: "request_user_review", arguments: { reason: "unclear" } }],
    { evidence: "spent 100 on dal", now: NOW },
  ).map((t) => t.name);
  cases += 1;
  A(!has(dropped, "request_user_review"), "stale review dropped after a real write");
  A(has(dropped, "create_expense_candidate"), "the salvaged write remains");

  const kept = expandToolCalls(
    [{ name: "request_user_review", arguments: { reason: "suspected prompt injection" } }],
    { evidence: "spent 100 on dal", now: NOW },
  ).map((t) => t.name);
  cases += 1;
  A(has(kept, "request_user_review"), "a safety review is kept even alongside a write");
}

// ---- mealSlotFromTime ----
const slot = (h) => mealSlotFromTime(`2026-06-30T${String(h).padStart(2, "0")}:00:00+05:30`);
A(slot(8) === "breakfast", "08:00 -> breakfast"); asserts += 0;
A(slot(13) === "lunch", "13:00 -> lunch");
A(slot(16) === "snack", "16:00 -> snack");
A(slot(20) === "dinner", "20:00 -> dinner");
A(slot(3) === "other", "03:00 -> other");

// ---- resolveOccurredAt (relative + explicit dates) ----
A(resolveOccurredAt("yesterday", NOW).slice(0, 10) === "2026-06-29", "yesterday -> -1 day");
A(resolveOccurredAt("today", NOW).slice(0, 10) === "2026-06-30", "today -> same day");
A(resolveOccurredAt("day before yesterday", NOW).slice(0, 10) === "2026-06-28", "day-before -> -2");
A(resolveOccurredAt("on 25 jun", NOW).slice(0, 10) === "2026-06-25", "explicit '25 jun'");
A(resolveOccurredAt("bought stuff on 25/06", NOW).slice(0, 10) === "2026-06-25", "explicit 25/06");

assert.ok(cases >= 1000, `expected a 1000+ case matrix, generated ${cases}`);
console.log(`labeller-matrix tests passed: ${cases} cases, ${asserts} assertions`);
