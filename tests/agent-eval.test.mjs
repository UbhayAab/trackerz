// THE CAPTURE EVAL SUITE.
//
// Replays real captures through the REAL deterministic layers - the ones that
// actually produced this app's documented bugs - and scores the result against a
// hand-written contract. Runs inside `npm test`: hermetic, offline, free, no
// model call, milliseconds.
//
// That is not a compromise, it is the point. On 2026-08-06 the brain routed a
// permanent diet change perfectly (update_plan_candidate at 0.95) and
// fan-out-expander appended a 540 kcal meal built from the instruction text. On
// 2026-08-04 a note about the app's JSON structure became a 432 kcal meal. In
// both cases the model was right and this layer was wrong, so replaying recorded
// model output through the live guards is exactly where the value is.
//
// The metric that must never drop is `must_not` precision. A hit is a hard zero
// for the case with no partial credit, because a phantom meal averaged against
// thirteen passing cases is how it survives a green build.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandToolCalls } from "../lib/fan-out-expander.mjs";
import { scoreCase, scoreSuite, checkArg, valueAt } from "../lib/eval-score.mjs";

const corpus = JSON.parse(readFileSync("tests/corpus/cases.json", "utf8"));
const NOW = corpus.now;

// --- the scorer itself, before trusting it to judge anything -----------------
{
  assert.equal(checkArg("skipped", "skipped"), true);
  assert.equal(checkArg("done", "skipped"), false);
  assert.equal(checkArg("2 scoops whey", { contains: ["whey"] }), true);
  assert.equal(checkArg("2 scoops whey", { contains: ["whey", "curd"] }), false);
  assert.equal(checkArg("permanent", { matches: "/^perm/" }), true);
  assert.equal(checkArg(undefined, { absent: true }), true);
  assert.equal(checkArg(540, { atLeast: 100 }), true);
  assert.equal(valueAt({ a: { b: 1 } }, "a.b"), 1);
  assert.equal(valueAt({}, "a.b.c"), undefined, "a missing path must not throw");

  // A must_not hit is a hard zero even when everything else is perfect.
  const perfectButForbidden = scoreCase(
    { must: [{ tool: "update_plan_candidate" }], must_not: ["create_food_log_candidate"] },
    { toolCalls: [{ name: "update_plan_candidate" }, { name: "create_food_log_candidate" }] },
  );
  assert.equal(perfectButForbidden.score, 0, "a forbidden tool cannot be averaged away");
  assert.equal(perfectButForbidden.hard.length, 1);

  // Partial credit exists, so a 2-of-3 fan-out is not scored as a phantom meal.
  const partial = scoreCase(
    { must: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] },
    { toolCalls: [{ name: "a" }, { name: "b" }] },
  );
  assert.ok(partial.score > 0.4 && partial.score < 1, `partial credit, got ${partial.score}`);

  // An unexpected extra is recorded but does not fail the case.
  const extra = scoreCase({ must: [{ tool: "a" }] }, { toolCalls: [{ name: "a" }, { name: "zzz" }] });
  assert.equal(extra.score, 1);
  assert.deepEqual(extra.extras, ["zzz"]);
}

// --- run the corpus ----------------------------------------------------------
const results = [];
for (const c of corpus.cases) {
  const toolCalls = expandToolCalls(c.model || [], { evidence: c.input, now: NOW });
  const result = scoreCase(c.expect, { toolCalls });
  results.push({ id: c.id, tags: c.tags, weight: c.weight, result, toolCalls });
}

const suite = scoreSuite(results);

// --- report, so a failure is diagnosable without re-running ------------------
for (const r of results) {
  if (r.result.score < 1) {
    const got = r.toolCalls.map((t) => t.name).join(", ") || "(nothing)";
    console.log(`  ${r.result.hard.length ? "HARD" : "part"}  ${r.id}`);
    console.log(`        got: ${got}`);
    if (r.result.hard.length) console.log(`        hard: ${r.result.hard.join("; ")}`);
    if (r.result.misses.length) console.log(`        miss: ${r.result.misses.join("; ")}`);
  }
}

// --- gates -------------------------------------------------------------------

// 1. THE ONE THAT MATTERS. No capture may produce a forbidden tool, ever.
assert.deepEqual(
  suite.hardFails, [],
  `hard failures (a forbidden tool was emitted): ${JSON.stringify(suite.hardFails, null, 1)}`,
);

// 2. Every case tagged not-a-log must be PERFECT. This is the class that cost
//    the owner real, wrong numbers on the home screen twice.
assert.equal(suite.byTag["not-a-log"], 1,
  `the not-a-log class must be exactly 1.00, got ${suite.byTag["not-a-log"]}`);

// 3. The deterministic layers have no excuse - no model is involved.
assert.equal(suite.byTag.deterministic, 1,
  `deterministic cases must be exactly 1.00, got ${suite.byTag.deterministic}`);

// 4. The contrast cases prove the guards are not simply suppressing everything.
//    A guard that blocks the phantom AND the real meal is not a fix.
assert.equal(suite.byTag.contrast, 1,
  `contrast cases must be exactly 1.00 or the guards are over-broad, got ${suite.byTag.contrast}`);

// 5. Overall.
assert.ok(suite.mean >= 0.95, `weighted mean ${suite.mean.toFixed(3)} below 0.95`);

console.log(`agent-eval tests passed: ${suite.count} cases, mean ${suite.mean.toFixed(3)}, 0 hard failures`);
