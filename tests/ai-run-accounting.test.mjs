// AI RUN ACCOUNTING - what ends up on the ai_runs row: the cost, and which model
// really did the work.
//
// Two real defects locked down here.
//
// 1. THE DAILY CAP WAS OFF BY ~7x. estimateCostUsd() hardcoded 0.075 in / 0.3 out
//    - Gemini's stale rate card - and priced the DeepSeek answer pass, the
//    DeepSeek summary pass, and the whole-run fallback with it. Real DeepSeek is
//    0.55 / 2.2, so DEFAULT_DAILY_COST_CAP_USD = 2 was permitting roughly $12-16
//    of real spend per day. Gemini's own constants were a quarter of the true
//    2.5-Flash price (0.30 / 2.50) on top of that.
//
// 2. THE MODEL FALLBACK WAS SILENT. deepseek -> Gemini wrote provider
//    "gemini-fallback" and threw the caught error away. Against the live DB there
//    had been 5 such runs, the last on 25 July, and not one surfaced.
//
// The arithmetic below is EXECUTED out of the edge function so the rates and the
// cost helpers cannot drift from what the tests assert.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("supabase/functions/agent/index.ts", "utf8");

// --- pull the pricing block out of the Deno TS and run it --------------------

function grab(pattern, label) {
  const m = src.match(pattern);
  assert.ok(m, `could not find ${label} in the edge function`);
  return m[0];
}

const rateLine = grab(/const GEMINI_IN_USD = [\s\S]*?const DEEPSEEK_IN_USD = [^\n]*/, "the provider rate constants");
const costOfFn = grab(/function costOf\([\s\S]*?\n\}/, "costOf()");
const ratesFn = grab(/function ratesForProvider\([\s\S]*?\n\}/, "ratesForProvider()");

const asJs = [rateLine, costOfFn, ratesFn]
  .join("\n")
  .replace(/\?\s*:\s*string/g, "")
  .replace(/:\s*\[number, number\]/g, "")
  .replace(/:\s*number/g, "");
assert.ok(
  !/:\s*(number|string|boolean|any|\[number)/.test(asJs.replace(/\/\/[^\n]*/g, "")),
  "unexpected type annotation left in the pricing block - the extractor needs teaching about it",
);

const mod = await import(
  `data:text/javascript,${encodeURIComponent(`${asJs}\nexport { GEMINI_IN_USD, GEMINI_OUT_USD, DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD, costOf, ratesForProvider };`)}`
);
const { GEMINI_IN_USD, GEMINI_OUT_USD, DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD, costOf, ratesForProvider } = mod;

// --- 1. the rate cards are the real ones -------------------------------------

assert.equal(GEMINI_IN_USD, 0.3, "Gemini 2.5 Flash input is $0.30 / 1M, not the stale 0.075");
assert.equal(GEMINI_OUT_USD, 2.5, "Gemini 2.5 Flash output is $2.50 / 1M, not the stale 0.3");
assert.equal(DEEPSEEK_IN_USD, 0.55);
assert.equal(DEEPSEEK_OUT_USD, 2.2);

// --- 2. a DeepSeek run is priced at DeepSeek rates ---------------------------

const PT = 8000, OT = 1200;
const deepseekCost = costOf(DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD, PT, OT);
const geminiCost = costOf(GEMINI_IN_USD, GEMINI_OUT_USD, PT, OT);
const staleCost = (PT / 1_000_000) * 0.075 + (OT / 1_000_000) * 0.3;

// The run string is "+"-joined; the brain is the last entry and it decides.
assert.deepEqual(ratesForProvider("gemini-vision+deepseek-reasoner"), [DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD]);
assert.deepEqual(ratesForProvider("deepseek"), [DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD]);
assert.deepEqual(ratesForProvider(undefined), [DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD], "unattributed runs default to the pricier brain");
assert.deepEqual(ratesForProvider("gemini-vision+gemini-FALLBACK"), [GEMINI_IN_USD, GEMINI_OUT_USD]);

const [inRate, outRate] = ratesForProvider("gemini-vision+deepseek-reasoner");
const priced = costOf(inRate, outRate, PT, OT);
assert.equal(priced, deepseekCost, "a DeepSeek-attributed run must be priced with the DeepSeek rate card");
assert.notEqual(priced, geminiCost, "a DeepSeek run must NOT be priced at the Gemini rate");
assert.ok(priced > staleCost * 5, `DeepSeek work was being under-billed ~${(priced / staleCost).toFixed(1)}x by the old estimate`);

// --- 3. estimateCostUsd is gone and nothing prices blind ---------------------

// Comments name the removed helper on purpose (that is the incident record), so
// look at code lines only.
const code = src.replace(/^\s*\/\/[^\n]*$/gm, "");
assert.ok(!/estimateCostUsd/.test(code), "estimateCostUsd() is back - every cost must go through costOf() with the resolved provider's rates");
assert.ok(!/\*\s*0\.075/.test(code), "a hardcoded 0.075 rate is back in the edge function");

// The DeepSeek-only side passes (answer + journal summary) must use DeepSeek rates.
const pipeline = grab(/async function runPipeline\([\s\S]*?\n\}/, "runPipeline()");
const answerPricing = [...pipeline.matchAll(/answerCost \+?= costOf\((\w+), (\w+),/g)].map((m) => [m[1], m[2]]);
assert.equal(answerPricing.length, 2, "expected the answer pass and the journal summary to each price themselves");
for (const [i, o] of answerPricing) {
  assert.deepEqual([i, o], ["DEEPSEEK_IN_USD", "DEEPSEEK_OUT_USD"], "answerQuestion/summariseJournal are DeepSeek calls and must be priced as such");
}

// The jarvis function keeps its own copy of the same two lines - it prices the
// brief's voice model against its own DAILY_COST_CAP_USD, and it had the same
// stale Gemini card. Drift there is invisible until a bill arrives.
const jarvis = readFileSync("supabase/functions/jarvis/index.ts", "utf8");
const jarvisRates = jarvis.match(/const GEMINI_IN_USD = [^\n]*\nconst DEEPSEEK_IN_USD = [^\n]*/);
assert.ok(jarvisRates, "could not find the rate constants in the jarvis function");
assert.equal(
  jarvisRates[0].replace(/\s+/g, " "),
  rateLine.split("\n").filter((l) => l.startsWith("const ")).join("\n").replace(/\s+/g, " "),
  "agent and jarvis pricing tables have drifted",
);

// --- 4. the fallback is loud -------------------------------------------------

assert.ok(/usedProviders\.push\("gemini-FALLBACK"\)/.test(src), 'the deepseek -> Gemini fallback must record provider "gemini-FALLBACK", not a quiet value');
assert.ok(!/"gemini-fallback"/.test(code), "the old quiet fallback provider string is back");
assert.ok(/brainFallbackReason = `brain_fallback_to_gemini:/.test(src), "the fallback must capture WHY it fired, not swallow the error");
assert.ok(/error_message: typeof ri\.errorMessage/.test(src), "the fallback reason must be written to ai_runs.error_message");
// The reason has to survive both exits from runPipeline, including the injection one.
assert.equal(
  (pipeline.match(/errorMessage: brainFallbackReason/g) || []).length, 2,
  "every return path out of runPipeline must carry the fallback reason (the injection early-return included)",
);

// --- 5. a run that FAILS is recorded ----------------------------------------
//
// Section 4 above made the brain-fallback reason reachable, and it works. But a
// 2026-08-08 audit of the live DB found `error_message` null on all 181 ai_runs
// rows and `status` holding only 'completed' (124) and 'succeeded' (57) - never
// 'errored'. Both halves have the same cause and it is not the fallback path:
//
//   persistRunAndActions is only ever called on the SUCCESS path and hardcodes
//   status: "completed". The top-level Deno.serve catch returned a 500 to the
//   client and wrote NOTHING. So every thrown run - provider timeout, unparsable
//   JSON, an unreachable function, a failed insert - left no row at all.
//
// The evidence in the live data: the "6 boiled eggs" capture of 2026-07-24 died
// with "Failed to send a request to the Edge Function" and has 1 ai_action and
// ZERO ai_runs rows. And src/ui/audit-log.js has been branching on
// `runs.some(r => r.status === "errored")` for a value nothing could write.
//
// A failure table that only ever receives successes reads as a 0% failure rate.
{
  const handler = src.slice(src.indexOf("Deno.serve(async (req)"));
  const catchBlock = handler.slice(handler.lastIndexOf("} catch (error) {"));

  assert.match(
    catchBlock,
    /from\("ai_runs"\)\s*\.insert\(/,
    "the top-level catch must write an ai_runs row - a 500 that records nothing is why the failure table is all nulls",
  );
  assert.match(catchBlock, /status: "errored"/, 'a failed run must be stored as status "errored" - the value src/ui/audit-log.js already looks for');
  assert.match(catchBlock, /error_message: message/, "the failed run must carry the reason, not just the status");
  assert.match(
    catchBlock,
    /estimated_cost_usd: 0/,
    "a run that threw is not billed by this function: 0, so an errored row cannot eat the daily cost cap",
  );

  // The ids have to be captured OUTSIDE the try or the catch cannot name who
  // failed, and the insert must be wrapped so a logging failure never replaces
  // the real error with a different one.
  assert.ok(
    /let failedUserId[\s\S]{0,200}try \{/.test(handler),
    "failedUserId/failedIngestionId must be declared before the try, or the catch has nothing to write",
  );
  assert.ok(
    /try \{[\s\S]{0,600}from\("ai_runs"\)[\s\S]{0,400}\} catch \{/.test(catchBlock),
    "the failure-logging insert must be wrapped in its own try - it must never mask the original error",
  );
  // And the 500 still goes out regardless.
  assert.match(catchBlock, /return Response\.json\(\{ ok: false, error: message \}, \{ status: 500/, "the 500 response must survive the logging");
}

console.log("ai-run-accounting tests passed: DeepSeek priced at DeepSeek rates, model fallback is loud, failed runs are recorded");
