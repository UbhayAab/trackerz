// PIPELINE-STAGES GUARD — keeps the AI engine a NAMED, ORDERED layer instead of
// scattered logic. Asserts every stage function exists in the edge function, that
// the critical order holds (ground → sanity → persist; reason → parse → fan-out),
// and that each pure stage has its lib/src mirror (so it stays unit-testable).
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");

// --- every stage function is present in the edge orchestrator ----------------
const STAGE_FNS = [
  "fetchContextBlock",   // 1 build-context
  "geminiExtract",       // 2 extract
  "runBrain", "geminiReason", // 3 reason (+ fallback)
  "parseToolCalls",      // 4 parse
  "validateToolArguments", // 5 validate
  "resolveOccurredAt",   // 6 normalize (date)
  "expandToolCalls",     // 7 fan-out / salvage / route
  "recomputeFoodMacros", // 7b macro normalize
  "isGrounded",          // 8 ground
  "sanityCheck",         // 9 sanity
  "applyTool", "tableForTool", // 10 persist
];
for (const fn of STAGE_FNS) {
  assert.ok(new RegExp(`function ${fn}\\b`).test(edge), `pipeline stage function "${fn}" missing from index.ts`);
}

// --- order: within persistRunAndActions, ground → sanity → persist -----------
// Isolate a function body by brace-matching from its signature (handles multi-line
// signatures + nested braces; the targeted functions hold no braces-in-strings).
function bodyOf(sig) {
  const at = edge.search(new RegExp(sig));
  assert.ok(at !== -1, `could not find ${sig}`);
  // Anchor on the body opener ") {" so a "{" inside the param/type annotation
  // (e.g. runInfo: { … }) is not mistaken for the function body.
  const sigEnd = edge.indexOf(") {", at);
  const open = edge.indexOf("{", sigEnd);
  let depth = 0, end = -1;
  for (let i = open; i < edge.length; i++) {
    if (edge[i] === "{") depth++;
    else if (edge[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, `could not isolate ${sig}`);
  return edge.slice(open, end + 1);
}
const persist = bodyOf("async function persistRunAndActions\\(");
const iGround = persist.indexOf("isGrounded(");
const iSanity = persist.indexOf("sanityCheck(");
const iApply = persist.indexOf("applyTool(");
assert.ok(iGround !== -1 && iSanity !== -1 && iApply !== -1, "ground/sanity/persist calls present in persist loop");
assert.ok(iGround < iSanity, "evidence grounding must run BEFORE sanity");
assert.ok(iSanity < iApply, "sanity must run BEFORE the row is applied (so the flag rides along)");

// --- order: within runPipeline, reason → parse → fan-out ---------------------
const pipe = bodyOf("async function runPipeline\\(");
assert.ok(pipe.indexOf("runBrain(") < pipe.indexOf("parseToolCalls("), "reason before parse");
assert.ok(pipe.indexOf("parseToolCalls(") < pipe.indexOf("expandToolCalls("), "parse before fan-out");

// --- handler builds context before running the pipeline ----------------------
const serve = edge.slice(edge.indexOf("Deno.serve"));
assert.ok(serve.indexOf("fetchContextBlock(") < serve.indexOf("runPipeline("), "context built before pipeline runs");

// --- each pure stage keeps a lib/src mirror (unit-testable without Deno) ------
const MIRRORS = [
  "lib/context-builder.mjs", "lib/fan-out-expander.mjs", "lib/capture-intent.mjs",
  "lib/request-router.mjs", "lib/negation.mjs", "lib/sanity-guards.mjs", "lib/food-nutrition.mjs",
  "src/agent/evidence-grounding.js", "src/agent/prompt-boundaries.js",
  "src/agent/tool-schemas.js", "src/agent/tool-registry.js",
];
for (const f of MIRRORS) {
  assert.ok(existsSync(f), `pure mirror "${f}" is missing — a stage lost its testable source of truth`);
}

console.log(`pipeline-stages tests passed: ${STAGE_FNS.length} stages present, order locked, ${MIRRORS.length} mirrors intact`);
