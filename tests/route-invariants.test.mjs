import assert from "node:assert/strict";
import {
  enforceRouteInvariants, hasStandingLanguage, isStandingChange, isDeltaPayload,
  LOG_TOOLS, PLAN_TOOLS,
} from "../lib/route-invariants.mjs";

const plan = (scope, payload) => ({ name: "update_plan_candidate", arguments: { kind: "diet", scope, payload }, confidence: 0.95 });
const meal = (d = "6 eggs") => ({ name: "create_food_log_candidate", arguments: { description: d }, confidence: 0.6 });
const names = (r) => r.calls.map((c) => c.name);
const codes = (r) => r.violations.map((v) => v.code);

// ---------------------------------------------------------------------------
// Standing language. The original cue list was written entirely in the
// imperative and missed the declarative voice people actually use, which is how
// "my diet has changed" routed as a log.
// ---------------------------------------------------------------------------
{
  for (const t of [
    "my diet has changed",
    "I every single day now have two scoops of whey",
    "from now on I eat 6 eggs",
    "I now have curd instead",
    "these days I skip breakfast",
    "ab se main roz 6 ande khata hoon",
    "I no longer eat rice",
  ]) assert.ok(hasStandingLanguage(t), `standing: "${t}"`);

  // An ordinary occasion must NOT trip it, or every meal stops being logged.
  for (const t of [
    "2 scoops whey and 500g curd",
    "6 boiled eggs",
    "had dal chawal for lunch",
    "went to the gym",
    "paid 240 zomato",
  ]) assert.ok(!hasStandingLanguage(t), `NOT standing: "${t}"`);
}

// ---------------------------------------------------------------------------
// Standing vs dated. The distinction was learned by breaking a real capture.
// ---------------------------------------------------------------------------
{
  assert.equal(isStandingChange(plan("permanent", {})), true);
  assert.equal(isStandingChange(plan("", {})), true, "an absent scope defaults to permanent in applyTool");
  assert.equal(isStandingChange(plan("2026-08-06", {})), false, "a named day is not the standing setup");
  assert.equal(isStandingChange(plan("2026-08-10,2026-08-17", {})), false);
  assert.equal(isStandingChange({ name: "set_target_candidate", arguments: {} }), true);
  assert.equal(isStandingChange(meal()), false);
  assert.equal(isStandingChange(null), false);

  assert.equal(isDeltaPayload({ op: "remove_meal", match: "banana" }), true);
  assert.equal(isDeltaPayload({ meals: [] }), false);
  assert.equal(isDeltaPayload(null), false);
}

// ---------------------------------------------------------------------------
// I1: a standing change may not also write a tracker row.
// ---------------------------------------------------------------------------
{
  const r = enforceRouteInvariants(
    [plan("permanent", { meals: [{ name: "Whey + curd" }] }), meal("Hey actually my diet has changed I every single day now have two scoops")],
    { evidence: "Hey actually my diet has changed I every single day now have two scoops of whey protein with 500 grams of curd" },
  );
  assert.deepEqual(names(r), ["update_plan_candidate"], "the phantom meal is dropped, the plan survives");
  assert.ok(codes(r).includes("log_in_standing_change"));
}

// ---------------------------------------------------------------------------
// I2: standing LANGUAGE alone is enough, with no plan tool at all. This is the
// path that runs when the brain is unavailable and only salvage produced rows.
// ---------------------------------------------------------------------------
{
  const r = enforceRouteInvariants([meal("two scoops of whey with 500g curd")], {
    evidence: "my diet has changed, I now have two scoops of whey with 500g curd every single day",
  });
  assert.deepEqual(names(r), [], "no plan tool needed - the words are enough");
  assert.ok(codes(r).includes("log_from_standing_language"));
}

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION. A guard that blocks the phantom AND the real meal is not
// a fix. Three cases that must all still log.
// ---------------------------------------------------------------------------
{
  // A date-scoped delta rides alongside a genuine log by design.
  const dated = enforceRouteInvariants([plan("2026-08-06", { op: "replace_workout" }), meal()], {
    evidence: "planned leg day but I did cardio, and had 6 boiled eggs after",
  });
  assert.ok(names(dated).includes("create_food_log_candidate"),
    "a DATE-scoped delta must not suppress the meal logged in the same breath");

  // An explicit logged event overrides everything.
  const mixed = enforceRouteInvariants([plan("permanent", { meals: [] }), meal("dal rice")], {
    evidence: "from now on 2 scoops whey daily. also I just had dal rice",
    carriesLoggedEvent: true,
  });
  assert.ok(names(mixed).includes("create_food_log_candidate"),
    "carriesLoggedEvent keeps the honest mixed capture working");

  // A plain meal with no plan tool and no standing words is untouched.
  const plain = enforceRouteInvariants([meal("2 scoops whey and 500g curd")], {
    evidence: "2 scoops whey and 500g curd",
  });
  assert.deepEqual(names(plain), ["create_food_log_candidate"]);
  assert.deepEqual(codes(plain), []);
}

// ---------------------------------------------------------------------------
// I3: a permanent scope may not carry a delta. The prompt says this in capitals
// and nothing enforced it - and sync.js silently DISCARDS permanent deltas, so
// the write is reported as applied and then never renders.
// ---------------------------------------------------------------------------
{
  const r = enforceRouteInvariants([plan("permanent", { op: "remove_meal", match: "banana" })], { evidence: "drop the banana" });
  assert.ok(codes(r).includes("permanent_delta"));
  assert.equal(names(r).length, 1, "it is FLAGGED, not dropped - a rejected plan change is a lost instruction");
  assert.equal(r.calls[0].arguments._needs_full_plan, true, "marked so the caller can ask for a full payload");

  // A dated delta is exactly right and must not be flagged.
  const ok = enforceRouteInvariants([plan("2026-08-06", { op: "remove_meal", match: "banana" })], { evidence: "drop the banana today" });
  assert.deepEqual(codes(ok), []);
}

// ---------------------------------------------------------------------------
// I4: a plan change that changes nothing is a silent no-op reported as success.
// ---------------------------------------------------------------------------
{
  const r = enforceRouteInvariants([plan("permanent", {})], { evidence: "update my plan" });
  assert.ok(codes(r).includes("empty_plan_change"));
}

// ---------------------------------------------------------------------------
// Hygiene.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(enforceRouteInvariants([], {}).calls, []);
  assert.deepEqual(enforceRouteInvariants([], {}).violations, []);
  assert.ok(LOG_TOOLS.has("create_food_log_candidate"));
  assert.ok(!LOG_TOOLS.has("create_note_candidate"), "a note is not a tracker row");
  assert.ok(PLAN_TOOLS.has("update_plan_candidate"));

  // Never mutates the caller's array.
  const input = [meal()];
  const snapshot = JSON.stringify(input);
  enforceRouteInvariants(input, { evidence: "my diet has changed" });
  assert.equal(JSON.stringify(input), snapshot);
}

console.log("route-invariants tests passed");
