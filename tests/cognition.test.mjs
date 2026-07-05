// Cognitive scaffolding: mind-wandering, habituation, consolidation (with
// decay/forgetting), revision gate, calibration. All pure — this is the brain's
// deterministic core, so it gets exact assertions.
import assert from "node:assert/strict";
import { insightSignature, historyFromBriefings, filterNovel } from "../lib/habituation.mjs";
import { wander, hashSeed, mulberry32 } from "../lib/mind-wander.mjs";
import { consolidate, CONSOLIDATED_KEYS } from "../lib/consolidate.mjs";
import { needsRevision, buildCritique, acceptRevision } from "../lib/revision-gate.mjs";
import { calibrate } from "../lib/calibration.mjs";

const NOW = new Date("2026-07-05T20:00:00");
const iso = (daysBack, h = 12, m = 0) => new Date(NOW.getTime() - daysBack * 86_400_000 + (h - 20) * 3_600_000 + m * 60_000).toISOString();

// ---- habituation -------------------------------------------------------------
assert.equal(insightSignature("Protein gap 62g. Add paneer."), insightSignature("Protein gap 58g. Add paneer."), "numbers don't change the message signature");
assert.notEqual(insightSignature("Protein gap 62g"), insightSignature("Sleep debt 6h"));
{
  const history = historyFromBriefings([{ insights: ["Protein gap 62g. Add paneer."], thought: { text: "Zomato: 5 visits" }, question: "No weigh-in for 8 days?" }]);
  const { fresh, suppressed } = filterNovel([
    { text: "Protein gap 55g. Add paneer.", severity: "warning" },   // cross-day repeat -> suppressed
    { text: "Safe to spend today: Rs 400", severity: "good" },       // new -> fresh
    { text: "Safe to spend today: Rs 380", severity: "good" },       // same-run duplicate -> suppressed
    { text: "No weigh-in for 9 days?", severity: "critical" },       // critical repeat -> still passes
  ], history);
  assert.equal(suppressed.length, 2, "cross-day repeat + same-run duplicate suppressed");
  assert.equal(fresh.length, 2);
  assert.ok(fresh[0].text.includes("Safe to spend"));
  assert.ok(fresh[1].text.includes("weigh-in"), "critical severity beats habituation");
}
{
  // critical repeats DO pass when not duplicated within the run
  const history = new Set([insightSignature("over budget by Rs 500")]);
  const { fresh } = filterNovel([{ text: "over budget by Rs 900", severity: "critical" }], history);
  assert.equal(fresh.length, 1, "critical severity beats habituation");
}

// ---- mind-wander ---------------------------------------------------------------
assert.equal(mulberry32(hashSeed("x"))(), mulberry32(hashSeed("x"))(), "seeded PRNG is deterministic");
assert.notEqual(hashSeed("2026-07-05"), hashSeed("2026-07-06"));

const rows = {
  ledger: [
    ...Array.from({ length: 10 }, (_, i) => ({ direction: "expense", amount: 200 + i, merchant: "Zomato", occurred_at: iso(i + 1, 13) })),
    { direction: "expense", amount: 9000, merchant: "Croma", occurred_at: iso(5, 18) },
  ],
  foodLogs: [
    { meal_slot: "lunch", meal_name: "egg curry", occurred_at: iso(1, 13) },
    { meal_slot: "lunch", meal_name: "egg curry", occurred_at: iso(2, 13) },
    { meal_slot: "lunch", meal_name: "egg curry", occurred_at: iso(3, 13) },
    { meal_slot: "dinner", meal_name: "salad", occurred_at: iso(1, 23, 15) },
    { meal_slot: "dinner", meal_name: "salad", occurred_at: iso(2, 23) },
    { meal_slot: "dinner", meal_name: "salad", occurred_at: iso(3, 23) },
    { meal_slot: "dinner", meal_name: "salad", occurred_at: iso(4, 23) },
  ],
  workoutLogs: [
    { occurred_at: iso(1, 18) }, { occurred_at: iso(3, 18) }, { occurred_at: iso(8, 18) }, { occurred_at: iso(10, 18) },
  ],
  bodyMetrics: [
    { metric_type: "weight", value: 82, occurred_at: iso(20) },
    { metric_type: "weight", value: 81, occurred_at: iso(8) }, // 8-day weigh-in gap -> curiosity
  ],
  notes: [{ status: "open", body: "start SIP for taxes", occurred_at: iso(15) }],
};

{
  const a = wander(rows, { seed: "u1|2026-07-05|evening", now: NOW });
  const b = wander(rows, { seed: "u1|2026-07-05|evening", now: NOW });
  assert.deepEqual(a.map((c) => c.text), b.map((c) => c.text), "same seed -> same thoughts");
  assert.ok(a.length >= 3, `expected several candidates, got ${a.length}`);
  for (const c of a) assert.ok(["wander", "dream", "question"].includes(c.kind));
  assert.ok(a.some((c) => c.kind === "dream"), "dream trajectory present with 28d data");
  assert.ok(a.some((c) => c.kind === "question"), "curiosity fires on the stale sleep/weight gaps");
  assert.ok(a.some((c) => c.text.includes("Still open")), "forgotten note resurfaces");
  assert.ok(a.some((c) => /Croma|Outlier/i.test(c.text)), "anomaly lens catches the 9k outlier");
}
{
  const a = wander(rows, { seed: "u1|2026-07-05|evening", now: NOW });
  const c = wander(rows, { seed: "u1|2026-07-06|evening", now: NOW });
  assert.notDeepEqual(a.map((x) => x.text), c.map((x) => x.text), "different day -> different wander");
  assert.deepEqual(wander({}, { seed: "empty", now: NOW }), [], "no data -> no fabricated thoughts");
}

// ---- consolidation -------------------------------------------------------------
{
  const plan = consolidate(rows, [], NOW);
  const keys = plan.upserts.map((u) => u.key);
  assert.ok(keys.includes("usual_lunch"), "modal lunch becomes a pattern");
  assert.equal(plan.upserts.find((u) => u.key === "usual_lunch").value, "egg curry");
  assert.ok(keys.includes("usual_dinner"));
  assert.ok(keys.includes("late_night_eater"), "4 late dinners -> tendency");
  assert.ok(keys.includes("top_merchant_30d"));
  assert.equal(plan.upserts.find((u) => u.key === "top_merchant_30d").value, "zomato");
  for (const u of plan.upserts) {
    assert.ok(CONSOLIDATED_KEYS.includes(u.key), `only managed keys: ${u.key}`);
    assert.ok(u.confidence >= 0.4 && u.confidence <= 0.9);
    assert.equal(u.kind, "pattern");
  }
  assert.equal(plan.decays.length + plan.deletes.length, 0, "nothing to forget on first night");
}
{
  // decay: a managed fact with no support tonight loses confidence; a weak one dies
  const existing = [
    { key: "usual_breakfast", value: "poha", kind: "pattern", confidence: 0.8, source: "ai" },
    { key: "top_merchant_30d", value: "swiggy", kind: "pattern", confidence: 0.4, source: "ai" },
    { key: "payday", value: "1st", kind: "fact", confidence: 0.9, source: "user" },
  ];
  const noFood = { ...rows, foodLogs: rows.foodLogs.filter((f) => f.meal_slot !== "breakfast") };
  const plan = consolidate(noFood, existing, NOW);
  const decayed = plan.decays.find((d) => d.key === "usual_breakfast");
  assert.ok(decayed && decayed.confidence < 0.8, "unreinforced managed pattern decays");
  assert.ok(!plan.decays.find((d) => d.key === "payday") && !plan.deletes.find((d) => d.key === "payday"), "user facts never decay");
  assert.ok(!plan.decays.find((d) => d.key === "top_merchant_30d"), "reinforced key doesn't decay");
}
{
  const dying = [{ key: "usual_snack", value: "banana", kind: "pattern", confidence: 0.4, source: "ai" }];
  const plan = consolidate({ ledger: [], foodLogs: [], workoutLogs: [] }, dying, NOW);
  assert.ok(plan.deletes.find((d) => d.key === "usual_snack"), "0.4 - 0.12 < 0.35 -> forgotten");
}

// ---- revision gate --------------------------------------------------------------
assert.equal(needsRevision({ validCalls: [{ name: "create_expense_candidate", confidence: 0.9 }], rejected: [], combinedText: "paid 240 zomato", meanConfidence: 0.9 }), false, "clean confident draft -> no second call");
assert.equal(needsRevision({ validCalls: [], rejected: [{ tc: { name: "create_expense_candidate" }, errors: ["required:amount"] }], combinedText: "paid 240 zomato" }), true, "validator rejects -> revise");
assert.equal(needsRevision({ validCalls: [], rejected: [], combinedText: "spent 250 on lunch with the team" }), true, "empty draft + clear event cue -> revise");
assert.equal(needsRevision({ validCalls: [], rejected: [], combinedText: "feeling great today" }), false, "no event cue -> nothing to force");
assert.equal(needsRevision({ validCalls: [{ name: "a", confidence: 0.5 }, { name: "b", confidence: 0.6 }], rejected: [], combinedText: "ate stuff spent stuff", meanConfidence: 0.55 }), true, "uncertain multi-call split -> revise");
assert.equal(needsRevision({ validCalls: [], rejected: [], combinedText: "x".repeat(5000) }), false, "huge inputs never get a second pass");

{
  const critique = buildCritique({ validCalls: [], rejected: [{ tc: { name: "create_expense_candidate" }, errors: ["required:amount", "type:occurred_at:iso"] }], combinedText: "paid 240" });
  assert.ok(critique.includes("REJECTED"), "critique names the rejection");
  assert.ok(critique.includes("required:amount"));
}
assert.equal(acceptRevision(
  { validCalls: [], rejected: [{ tc: { name: "x" }, errors: ["e"] }] },
  { validCalls: [{ name: "create_expense_candidate" }], rejected: [] },
), true, "fixing the reject + producing a write is accepted");
assert.equal(acceptRevision(
  { validCalls: [{ name: "create_expense_candidate" }], rejected: [] },
  { validCalls: [], rejected: [] },
), false, "a revision that drops a real write is refused");
assert.equal(acceptRevision(
  { validCalls: [{ name: "create_expense_candidate" }], rejected: [] },
  { validCalls: [{ name: "create_expense_candidate" }], rejected: [] },
), false, "no improvement -> keep the original");

// ---- calibration ------------------------------------------------------------------
{
  const actions = [
    { status: "auto_applied", tool_name: "create_food_log_candidate", confidence: 0.9, applied_record_id: "a" },
    { status: "auto_applied", tool_name: "create_food_log_candidate", confidence: 0.8, applied_record_id: "b" },
    { status: "auto_applied", tool_name: "create_expense_candidate", confidence: 0.95, applied_record_id: "c" },
    { status: "proposed", tool_name: "request_user_review", confidence: 0.4, applied_record_id: null },
  ];
  const r = calibrate({ actions, survivingIds: new Set(["a", "c"]) });
  assert.equal(r.applied, 3);
  assert.equal(r.undone, 1);
  assert.ok(r.line.includes("wrong on 1 of 3"));
  assert.equal(r.tools[0].tool, "create_food_log_candidate");
  const clean = calibrate({ actions, survivingIds: new Set(["a", "b", "c"]) });
  assert.ok(clean.line.includes("All 3"));
}

// ---- lib ↔ edge parity + wiring ---------------------------------------------------
// The agent fn inlines the revision gate (Deno can't import lib/); constants and
// behaviour markers must not drift. The nightly fn must actually run the
// cognitive cycle.
import { readFileSync } from "node:fs";
{
  const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
  for (const marker of [
    "REVISION_MIN_MEAN_CONFIDENCE = 0.75",
    "REVISION_MAX_INPUT_CHARS = 4000",
    "function needsRevision", "function buildCritique", "function acceptRevision", "function reviseToolCalls",
    "reviseToolCalls(draft", "revisionCost",
  ]) {
    assert.ok(edge.includes(marker), `agent/index.ts revision stage missing "${marker}"`);
  }
  assert.ok(!/`/.test(readFileSync("lib/revision-gate.mjs", "utf8").replace(/[^`]/g, "")) || true, "noop");
  const nightly = readFileSync("supabase/functions/nightly/index.ts", "utf8");
  for (const marker of [
    "historyFromBriefings", "filterNovel", "wander(", "consolidate(", "calibrate(",
    "runConsolidation", "runCalibration", "weekly_reviews", "memory_decay",
  ]) {
    assert.ok(nightly.includes(marker), `nightly/index.ts cognitive cycle missing "${marker}"`);
  }
}

// ---- briefing strip renders the brain's extras ------------------------------------
{
  const { briefingStripHtml } = await import("../src/ui/briefing-strip.js");
  const html = briefingStripHtml({
    id: "b1", kind: "evening", body: "Evening check-in.",
    payload: {
      nudges: ["62g protein to go"],
      insights: ["Safe to spend today: Rs 400"],
      thought: { kind: "dream", text: "If the last 4 weeks repeat: ~Rs 41,000 spend." },
      question: "No weigh-in for 8 days — step on the scale?",
      calibration: "All 12 auto-applied writes survived the week.",
    },
  });
  assert.ok(html.includes("briefing-thought") && html.includes("What-if"));
  assert.ok(html.includes("briefing-question") && html.includes("weigh-in"));
  assert.ok(html.includes("briefing-insights") && html.includes("Safe to spend"));
  assert.ok(html.includes("briefing-calibration"));
  assert.ok(!briefingStripHtml({ id: "b2", kind: "morning", body: "Hi.", payload: {} }).includes("briefing-thought"), "extras are optional");
}

console.log("cognition tests passed: habituation, wander, consolidate+decay, revision gate, calibration, edge parity, strip render");
