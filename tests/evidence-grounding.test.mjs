// EVIDENCE GROUNDING - and the structural guard that stops a write tool from
// silently skipping it.
//
// isGrounded() ended in `default: return true` with a comment claiming only
// non-write tools reached it. That was false: seven WRITE_TOOLS members -
// update_plan_candidate, set_target_candidate, remember_fact,
// create_note_candidate, create_reminder_candidate, create_hydration_candidate,
// create_sleep_candidate - had no case at all and were never field-checked.
// Combined with AUTO_APPLY_MIN_CONFIDENCE = 0, that left the plan, the targets
// and the durable memory replayed into every later prompt with zero grounding.
// The set-equality test at the bottom is the part that must not be deleted: it
// fails the build the next time a tool is added to WRITE_TOOLS without a case.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isGrounded, evidenceHasNumber, hasWordOverlap, evidenceHasClockTime } from "../src/agent/evidence-grounding.js";

// Numbers: standalone match, comma-insensitive, digit-boundary aware.
assert.equal(evidenceHasNumber(240, "Paid Rs 240 to Zomato"), true);
assert.equal(evidenceHasNumber(1240, "balance ₹1,240 after"), true);
assert.equal(evidenceHasNumber(240, "order id 1240xyz"), false, "240 must not match inside 1240");
assert.equal(evidenceHasNumber(82.4, "weight 82.4 kg morning"), true);
assert.equal(evidenceHasNumber(500, ""), false);

// Word overlap.
assert.equal(hasWordOverlap("dal rice curd", "lunch was dal and rice"), true);
assert.equal(hasWordOverlap("paneer tikka", "had veg biryani"), false);

// Clock times out of an ISO stamp, 24h and 12h.
assert.equal(evidenceHasClockTime("2026-08-06T23:30:00+05:30", "bed at 11:30, up at 6:30"), true);
assert.equal(evidenceHasClockTime("2026-08-07T06:30:00+05:30", "bed at 11:30, up at 6:30"), true);
assert.equal(evidenceHasClockTime("2026-08-06T23:00:00+05:30", "slept 11pm to 7am"), true);
assert.equal(evidenceHasClockTime("2026-08-06T23:30:00+05:30", "had dal and rice"), false);
assert.equal(evidenceHasClockTime(null, "bed at 11:30"), false);

// Grounded expense (amount present) → true; fabricated amount → false.
assert.equal(isGrounded("create_expense_candidate", { amount: 240, merchant: "Zomato" }, "paid 240 zomato"), true);
assert.equal(isGrounded("create_expense_candidate", { amount: 9999, merchant: "Zomato" }, "paid 240 zomato"), false);

// No evidence at all → cannot ground → force review.
assert.equal(isGrounded("create_expense_candidate", { amount: 240 }, ""), false);

// Food grounded by description overlap (e.g. from vision OCR text).
assert.equal(isGrounded("create_food_log_candidate", { description: "dal rice curd" }, "plate of dal, rice, curd"), true);

// Body metric grounded by the numeric value.
assert.equal(isGrounded("create_body_metric_candidate", { metric_type: "weight", value: 82.4 }, "82.4 morning"), true);

// Non-write tools are never gated here.
assert.equal(isGrounded("request_user_review", {}, ""), true);

// --- the seven that used to skip grounding entirely --------------------------

// TARGET. The figure the budget is set to must be a figure the user said.
assert.equal(isGrounded("set_target_candidate", { kind: "daily_protein", amount: 180 }, "raise my protein goal to 180"), true);
assert.equal(isGrounded("set_target_candidate", { kind: "weekly_workouts", amount: 5 }, "I want to hit the gym 5 times a week"), true);
// The TARGET CASCADE derives a number the user never gave - correctly flagged.
assert.equal(isGrounded("set_target_candidate", { kind: "daily_calories", amount: 2300 }, "lean bulk to 90kg"), false);

// HYDRATION. ml, or the same volume written in whole litres.
assert.equal(isGrounded("create_hydration_candidate", { ml: 500 }, "drank 500 ml water"), true);
assert.equal(isGrounded("create_hydration_candidate", { ml: 1000 }, "drank 1 litre of water"), true);
assert.equal(isGrounded("create_hydration_candidate", { ml: 2000 }, "2 litres of water today"), true);
assert.equal(isGrounded("create_hydration_candidate", { ml: 750 }, "had some water"), false);

// SLEEP - three shapes, and the marker shape has no number to check.
assert.equal(isGrounded("create_sleep_candidate", { hours: 7 }, "slept 7h"), true);
assert.equal(isGrounded("create_sleep_candidate", { hours: 6.5 }, "slept about 6 and a half hours"), true, "floor of a stated duration still grounds");
assert.equal(
  isGrounded("create_sleep_candidate", { started_at: "2026-08-06T23:30:00+05:30", ended_at: "2026-08-07T06:30:00+05:30" }, "bed at 11:30, up at 6:30"),
  true,
);
assert.equal(
  isGrounded("create_sleep_candidate", { started_at: "2026-08-06T23:47:00+05:30" }, "going to sleep now"),
  true,
  "a bedtime marker carries no figure and must still pass",
);
assert.equal(isGrounded("create_sleep_candidate", { hours: 8 }, "had dal and rice for dinner"), false, "a duration nobody stated is not grounded");
assert.equal(isGrounded("create_sleep_candidate", {}, ""), false);

// PLAN. At least one meal / exercise name or the summary has to be in the evidence.
assert.equal(
  isGrounded("update_plan_candidate", {
    kind: "gym", scope: "2026-08-06", summary: "Cardio instead of legs",
    payload: { op: "replace_workout", workout: { name: "Cardio", kind: "cardio", items: ["30 min treadmill"] } },
  }, "swap today's leg day for cardio"),
  true,
);
assert.equal(
  isGrounded("update_plan_candidate", { kind: "diet", scope: "2026-08-06", payload: { op: "remove_meal", match: "banana" } }, "drop the banana snack today"),
  true,
);
assert.equal(
  isGrounded("update_plan_candidate", { kind: "diet", payload: { op: "set_targets", targets: { calories: 1800 } } }, "adjust my calorie budget to 1800"),
  true,
  "a targets-only delta grounds on its figure",
);
// A whole diet plan appearing from nowhere - the screenshot-of-someone-else case.
assert.equal(
  isGrounded("update_plan_candidate", {
    kind: "diet", scope: "permanent",
    payload: { meals: [{ name: "Paneer salad" }, { name: "Oats bowl" }], targets: { calories: 1800 } },
  }, "paid 240 zomato"),
  false,
);
// The op CODE must never ground the write: "add_meal" contains "add".
assert.equal(
  isGrounded("update_plan_candidate", { kind: "diet", payload: { op: "add_meal", meal: { name: "Sprouts chaat" } } }, "add a bowl of poha"),
  false,
  'the op code ("add_meal") must not word-match the user saying "add"',
);
assert.equal(isGrounded("update_plan_candidate", { kind: "diet" }, "here is my new plan"), false, "an empty payload grounds on nothing");

// MEMORY. A fabricated durable fact compounds - it is replayed into every prompt.
assert.equal(isGrounded("remember_fact", { key: "usual_lunch", value: "egg curry and 2 rotis" }, "my usual lunch is egg curry and 2 rotis"), true);
assert.equal(isGrounded("remember_fact", { key: "payday", value: "salary lands on the 1st" }, "paid 240 zomato"), false);

// NOTE + REMINDER.
assert.equal(isGrounded("create_note_candidate", { kind: "todo", body: "Book the dentist on Friday" }, "remind me to book the dentist friday"), true);
assert.equal(isGrounded("create_note_candidate", { kind: "aspiration", body: "Buy a new laptop" }, "had dal and rice"), false);
assert.equal(isGrounded("create_reminder_candidate", { title: "Mom's birthday", freq: "yearly" }, "mom's birthday is on 14 March"), true);
assert.equal(isGrounded("create_reminder_candidate", { title: "Renew insurance", freq: "yearly" }, "had dal and rice"), false);

// --- STRUCTURAL: every WRITE tool must have an explicit case ------------------
// This is the guard, not the behaviour tests above. Source-text analysis of the
// Deno edge function, same technique as tests/agent-contract.test.mjs.
const fn = readFileSync("supabase/functions/agent/index.ts", "utf8");

const writeToolsMatch = fn.match(/const WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(writeToolsMatch, "could not find WRITE_TOOLS in the edge function");
const writeTools = [...writeToolsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assert.ok(writeTools.length >= 15, `expected the full write-tool set, got ${writeTools.length}`);

const groundedBody = fn.match(/function isGrounded\([\s\S]*?\n\}/);
assert.ok(groundedBody, "could not find isGrounded in the edge function");
const groundedCases = new Set([...groundedBody[0].matchAll(/case "([^"]+)":/g)].map((m) => m[1]));

const ungrounded = writeTools.filter((t) => !groundedCases.has(t));
assert.deepEqual(
  ungrounded, [],
  `WRITE_TOOLS with no case in isGrounded (they fall through to "default: return true" and are written with NO field check): ${ungrounded.join(", ")}`,
);

// And nothing in the switch that is not a write tool - a stray case there means
// grounding is being applied to something that never writes a row.
const strayCases = [...groundedCases].filter((c) => !writeTools.includes(c));
assert.deepEqual(strayCases, [], `isGrounded has cases for non-write tools: ${strayCases.join(", ")}`);

// The edge function must actually call the guard before auto-applying.
assert.ok(/isGrounded\(tc\.name, tc\.arguments, evidence\)/.test(fn), "edge function must apply the evidence guard before auto-apply");
assert.ok(/rx\.test\(geminiEvidence\)/.test(fn), "edge function injection check must cover Gemini-extracted OCR/vision text");

// --- MIRROR PARITY with src/agent/evidence-grounding.js -----------------------
// The edge copy is hand-maintained. Compare the decision logic (comments and TS
// annotations stripped) so a fix to one copy cannot quietly miss the other.
const mirror = readFileSync("src/agent/evidence-grounding.js", "utf8");
for (const name of ["evidenceHasClockTime", "SLEEP_EVIDENCE_CUE", "PLAN_PHRASE_KEYS", "planPhrases"]) {
  assert.ok(fn.includes(name), `edge function is missing grounding helper ${name}`);
  assert.ok(mirror.includes(name), `src mirror is missing grounding helper ${name}`);
}

function decisionLogic(src) {
  const body = src.match(/function isGrounded\([\s\S]*?\n\}/);
  assert.ok(body, "isGrounded not found");
  const sw = body[0].slice(body[0].indexOf("switch (toolName)"));
  return sw
    .replace(/\/\/[^\n]*/g, "")      // comments differ in nothing but wrapping; drop them
    .replace(/\s+/g, " ")
    .trim();
}
assert.equal(
  decisionLogic(fn), decisionLogic(mirror),
  "isGrounded has DRIFTED between supabase/functions/agent/index.ts and src/agent/evidence-grounding.js",
);

console.log(`evidence-grounding tests passed: ${writeTools.length}/${writeTools.length} write tools grounded, mirror in sync`);
