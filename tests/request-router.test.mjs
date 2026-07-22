import assert from "node:assert/strict";
import {
  classifyRequestKind, isChangeRequest, carriesLoggedEvent,
  PLAN_CHANGE_CUES, BUDGET_CHANGE_CUES, QUERY_CUES,
} from "../lib/request-router.mjs";

const kind = (t) => classifyRequestKind(t);

// ---------------------------------------------------------------------------
// exported lexicons
// ---------------------------------------------------------------------------
for (const [n, lex] of Object.entries({ PLAN_CHANGE_CUES, BUDGET_CHANGE_CUES, QUERY_CUES })) {
  assert.ok(Array.isArray(lex) && lex.length > 0 && lex.every((w) => typeof w === "string"), `${n} ok`);
}

// ---------------------------------------------------------------------------
// PLAN CHANGE - the flagship: "change my schedule", not "tick the schedule"
// ---------------------------------------------------------------------------
assert.equal(kind("I want to change my gym schedule today"), "plan_change");
assert.equal(kind("here is a dump of my latest schedule, use this from now on"), "plan_change");
assert.equal(kind("for the next four Mondays and Wednesdays I'll have paneer salad"), "plan_change");
assert.equal(kind("make Thursdays a rest day"), "plan_change");
assert.equal(kind("update my diet plan: more protein at breakfast"), "plan_change");
assert.equal(kind("new plan from gpt: [pasted block]"), "plan_change");
assert.equal(kind("I won't do the schedule anymore, switch my plan to PPL"), "plan_change");
assert.equal(kind("replace Workout A with a swim day"), "plan_change");
assert.equal(kind("from now on no rice at dinner"), "plan_change");
assert.equal(kind("reschedule leg day to Friday"), "plan_change");

// ---------------------------------------------------------------------------
// BUDGET CHANGE - adjust a target, not a ₹0 expense
// ---------------------------------------------------------------------------
assert.equal(kind("adjust my calorie budget to 1800"), "budget_change");
assert.equal(kind("raise my protein goal to 180"), "budget_change");
assert.equal(kind("set my target to 1800 kcal"), "budget_change");
assert.equal(kind("change my monthly spend cap to 40000"), "budget_change");
assert.equal(kind("lower my food budget"), "budget_change");
assert.equal(kind("set my spend cap to 35k"), "budget_change");
// budget beats plan when both could match.
assert.equal(kind("change my plan and set my protein target to 180"), "budget_change");

// ---------------------------------------------------------------------------
// QUERY - a question, not an event
// ---------------------------------------------------------------------------
assert.equal(kind("how much did I spend this month"), "query");
assert.equal(kind("what did I eat yesterday"), "query");
assert.equal(kind("am I on track for protein"), "query");
assert.equal(kind("can I afford a 5000 gadget"), "query");
assert.equal(kind("show me my weekly summary"), "query");

// ---------------------------------------------------------------------------
// LOG - the default: a real event (must NOT be misread as a command)
// ---------------------------------------------------------------------------
assert.equal(kind("spent 250 on lunch at a cafe"), "log");
assert.equal(kind("had 3 rotis and dal for lunch"), "log");
assert.equal(kind("bought paneer and cheese for 50"), "log");
assert.equal(kind("made paneer sabzi which costed me 50 rupees"), "log");
assert.equal(kind("just made paneer sabzi"), "log");
assert.equal(kind("did Workout A, bench 3x10 60kg"), "log");
assert.equal(kind("ran 5k this morning"), "log");
assert.equal(kind("slept 7 hours"), "log");
assert.equal(kind(""), "log");
assert.equal(kind("   "), "log");

// isChangeRequest convenience
assert.equal(isChangeRequest("change my gym schedule"), true);
assert.equal(isChangeRequest("set my protein goal to 180"), true);
assert.equal(isChangeRequest("how much did I spend"), true, "a query is also not a log");
assert.equal(isChangeRequest("ate dal and rice"), false);
assert.equal(isChangeRequest("did legs today"), false);

// ---------------------------------------------------------------------------
// MIXED - a change message that also logs a real event (brain may still log it)
// ---------------------------------------------------------------------------
assert.equal(kind("change my plan to PPL; also I ate dal and rice today"), "plan_change");
assert.equal(carriesLoggedEvent("change my plan to PPL; also I ate dal and rice today"), true);
assert.equal(carriesLoggedEvent("change my gym schedule today"), false, "pure command carries no log");
assert.equal(carriesLoggedEvent("raise my protein goal"), false);

console.log("request-router tests passed");
