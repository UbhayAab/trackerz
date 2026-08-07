// MIRROR-PARITY GUARD - the anti-drift backbone of the AI engine.
//
// The Deno edge function (supabase/functions/agent/index.ts) cannot import repo
// lib/, so it HAND-COPIES every deterministic guard (lexicons, regexes, intent
// logic). Those copies silently drift - that is exactly what produced a duplicate
// eat-vs-buy implementation and a 14-term gap in looksLikeGym. This test fails the
// build the moment a lib source-of-truth and its inline edge twin diverge.
//
// Strategy: statically extract the named array/regex literals from BOTH files and
// assert equality; for representations that differ (lib arrays vs edge regexes for
// gym), assert BEHAVIORAL agreement over a corpus.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksLikeGym } from "../lib/capture-intent.mjs";
import { FOOD_WORDS } from "../lib/fan-out-expander.mjs";

const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
const fanout = readFileSync("lib/fan-out-expander.mjs", "utf8");
const router = readFileSync("lib/request-router.mjs", "utf8");

// --- extractors -------------------------------------------------------------

// Pull `const NAME = [ ... ]` and return the Set of quoted strings inside.
function stringArray(src, name) {
  const start = src.search(new RegExp(`\\b${name}\\s*=\\s*\\[`));
  assert.ok(start !== -1, `array ${name} not found`);
  const open = src.indexOf("[", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, `array ${name} not closed`);
  const body = src.slice(open + 1, end);
  return new Set([...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]));
}

// Pull `const NAME = /SOURCE/FLAGS;` and return "/SOURCE/FLAGS" (delimiter-aware).
function regexLiteral(src, name) {
  const at = src.search(new RegExp(`\\b${name}\\s*=\\s*/`));
  assert.ok(at !== -1, `regex ${name} not found`);
  const slash = src.indexOf("/", src.indexOf("=", at));
  let i = slash + 1, inClass = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }      // skip escaped char
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) break;   // closing delimiter
  }
  let j = i + 1;
  while (j < src.length && /[a-z]/i.test(src[j])) j++; // flags
  return src.slice(slash, j);
}

function assertSameSet(name, a, b) {
  const miss = [...a].filter((x) => !b.has(x));
  const extra = [...b].filter((x) => !a.has(x));
  assert.deepEqual({ miss, extra }, { miss: [], extra: [] },
    `DRIFT in ${name}: lib-only=${JSON.stringify(miss)} edge-only=${JSON.stringify(extra)}`);
}

// --- 1. string-array mirrors (same const name in lib + edge) ----------------
for (const [name, libSrc] of [
  ["FOOD_MERCHANTS", fanout], ["MONTHS", fanout],
  ["PLAN_CHANGE_CUES", router], ["BUDGET_CHANGE_CUES", router],
  ["QUERY_CUES", router], ["LOG_OVERRIDE_CUES", router],
]) {
  assertSameSet(name, stringArray(libSrc, name), stringArray(edge, name));
}

// FOOD_WORDS is DERIVED in lib/ (from the nutrition table) rather than written
// as a literal, so it cannot be extracted statically. Compare the lib's runtime
// value against the edge's literal - a stronger check than text equality, and
// the reason `node scripts/sync-mirror.mjs` regenerates that literal. A food
// added to food-nutrition.mjs without re-running sync fails here.
assertSameSet("FOOD_WORDS", new Set(FOOD_WORDS), stringArray(edge, "FOOD_WORDS"));

// --- 2. regex mirrors (same const name in lib + edge) -----------------------
for (const [name, libSrc] of [
  ["MONEY_CUE", fanout], ["MONEY_SUFFIX", fanout], ["MONEY_TRAIL", fanout],
  ["PURCHASE_CUE", fanout], ["FOR_LATER_CUE", fanout], ["CONSUMPTION_CUE", fanout],
]) {
  assert.equal(regexLiteral(edge, name), regexLiteral(libSrc, name), `DRIFT in regex ${name}`);
}

// --- 3. behavioral gym parity (lib arrays vs edge regexes) ------------------
// Reconstruct the edge's looksLikeGym from its extracted regexes and assert it
// agrees with the lib source-of-truth across a corpus. Catches array<->regex drift.
const GYM_CUE = new RegExp(regexLiteral(edge, "GYM_CUE").replace(/^\/|\/[a-z]*$/g, ""), "i");
const CARDIO_CUE = new RegExp(regexLiteral(edge, "CARDIO_CUE").replace(/^\/|\/[a-z]*$/g, ""), "i");
const CARDIO_FF = new RegExp(regexLiteral(edge, "CARDIO_FALSE_FRIENDS").replace(/^\/|\/[a-z]*$/g, ""), "");
const GYM_SET_REP = new RegExp(regexLiteral(edge, "GYM_SET_REP").replace(/^\/|\/[a-z]*$/g, ""), "i");
function edgeLooksLikeGym(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  if (GYM_CUE.test(t)) return true;
  if (CARDIO_CUE.test(t.replace(CARDIO_FF, " "))) return true;
  if (GYM_SET_REP.test(t)) return true;
  return false;
}
// --- 4. jarvis-brief block parity (lib/jarvis-brief.mjs ↔ jarvis edge fn) ----
// The whole brain block is copied verbatim into supabase/functions/jarvis/index.ts
// between the same markers. Compare the full text between markers, byte for byte.
function mirrorBlock(src, file) {
  const start = src.indexOf("JARVIS-BRIEF MIRROR START");
  const end = src.indexOf("JARVIS-BRIEF MIRROR END");
  assert.ok(start !== -1 && end !== -1 && end > start, `jarvis mirror markers missing in ${file}`);
  const afterStartLine = src.indexOf("\n", start) + 1;
  const endLineStart = src.lastIndexOf("\n", end) + 1;
  return src.slice(afterStartLine, endLineStart);
}
{
  const jarvisEdgePath = "supabase/functions/jarvis/index.ts";
  const jarvisLib = readFileSync("lib/jarvis-brief.mjs", "utf8");
  const jarvisEdge = readFileSync(jarvisEdgePath, "utf8");
  assert.equal(
    mirrorBlock(jarvisEdge, jarvisEdgePath),
    mirrorBlock(jarvisLib, "lib/jarvis-brief.mjs"),
    "DRIFT in JARVIS-BRIEF mirror block: lib/jarvis-brief.mjs and the jarvis edge fn have diverged",
  );
}

// --- 5. sleep-window block parity (lib/sleep-window.mjs -> agent edge fn) -----
// The sleep window resolver is copied verbatim into the agent edge function
// between SLEEP-WINDOW markers. Any drift means "slept 7h" resolves differently
// on the server than in the client applier that imports the same lib.
function markedBlock(src, file, startMark, endMark) {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark);
  assert.ok(start !== -1 && end !== -1 && end > start, `${startMark} markers missing in ${file}`);
  // Line endings are a checkout artifact, not drift. This repo is authored on
  // Windows so most files are CRLF, but lib/sleep-window.mjs is LF, and the raw
  // byte comparison failed on that alone while the two blocks were character for
  // character identical. Normalising CR cannot hide a semantic difference - any
  // real divergence still fails.
  return src.slice(src.indexOf("\n", start) + 1, src.lastIndexOf("\n", end) + 1).replace(/\r\n/g, "\n");
}
{
  const sleepLib = readFileSync("lib/sleep-window.mjs", "utf8");
  assert.equal(
    markedBlock(edge, "supabase/functions/agent/index.ts", "SLEEP-WINDOW MIRROR START", "SLEEP-WINDOW MIRROR END"),
    markedBlock(sleepLib, "lib/sleep-window.mjs", "SLEEP-WINDOW MIRROR START", "SLEEP-WINDOW MIRROR END"),
    "DRIFT in SLEEP-WINDOW mirror block: lib/sleep-window.mjs and the agent edge fn have diverged",
  );
}

// --- 5b. reminders block parity (lib/reminders.mjs -> jarvis edge fn) --------
// The recurrence engine is copied verbatim into the jarvis edge function between
// REMINDERS markers. Drift here means a birthday or a filing deadline resolves to
// a different date on the server than in the UI that shows the user when it is
// next due - the two would disagree about a date the user is relying on.
{
  const remLib = readFileSync("lib/reminders.mjs", "utf8");
  const jarvisSrc = readFileSync("supabase/functions/jarvis/index.ts", "utf8");
  assert.equal(
    markedBlock(jarvisSrc, "supabase/functions/jarvis/index.ts", "REMINDERS MIRROR START", "REMINDERS MIRROR END"),
    markedBlock(remLib, "lib/reminders.mjs", "REMINDERS MIRROR START", "REMINDERS MIRROR END"),
    "DRIFT in REMINDERS mirror block: run `node scripts/sync-mirror.mjs`",
  );
}

const GYM_CORPUS = [
  "did Workout A", "did chest and back", "worked out today", "bench 3x10 60kg",
  "squat 60kg 3x8", "leg press 2x12", "ran 5k", "walked 35 min", "brisk walk",
  "cooldown walk", "10k steps", "did my workout", "hit the gym", "session done",
  "lifted heavy", "did legs", "leg day", "plank 3x30s", "ohp 3x12",
  "grocery run at dmart", "run an errand", "had dal and rotis", "spent 250 on lunch",
  "bought paneer for the week", "change my gym schedule", "slept 7 hours", "",
  "incline db press 2x10", "did shoulders", "did arms", "3x12",
];
for (const s of GYM_CORPUS) {
  assert.equal(edgeLooksLikeGym(s), looksLikeGym(s),
    `GYM DRIFT on ${JSON.stringify(s)}: edge=${edgeLooksLikeGym(s)} lib=${looksLikeGym(s)}`);
}

console.log(`mirror-parity tests passed: lexicons + regexes + gym-behaviour lib↔edge in sync`);


// EVERY NEGATION CONSTANT MUST EXIST IN THE EDGE COPY.
//
// lib/negation.mjs is NOT in scripts/sync-mirror.mjs, because the edge copy
// carries TypeScript annotations and cannot be byte-identical. The existing
// parity check compares extracted string LEXICONS, so adding a whole new regex
// to lib left it green while the guard was missing from production entirely -
// NEG_CEASE ("stop eating the aloo bhujia") shipped to lib and never to the
// edge, and only a second, unrelated layer stopped the phantom meal.
//
// A structural check instead of a lexical one: if lib declares it, the edge has
// to declare it too, whatever its types look like.
{
  const libSrc = readFileSync("lib/negation.mjs", "utf8");
  const edgeSrc = readFileSync("supabase/functions/agent/index.ts", "utf8");
  const names = [...libSrc.matchAll(/^const (NEG_[A-Z_]+)\s*=/gm)].map((m) => m[1]);
  assert.ok(names.length >= 6, `expected the negation lexicon, found ${names.length}`);
  for (const n of names) {
    assert.ok(edgeSrc.includes(`const ${n} `) || edgeSrc.includes(`const ${n}=`),
      `${n} is declared in lib/negation.mjs and MISSING from the agent function - the guard is not in production`);
    // Declared is not enough: NEG_CEASE could have been pasted in and never
    // wired into clauseDeniesEvent, which reads identically from a diff and does
    // nothing at all. NEG_CLAUSE_SPLIT is the one that is consumed by .split().
    const used = edgeSrc.includes(`${n}.test(`) || edgeSrc.includes(`split(${n})`);
    assert.ok(used, `${n} exists in the agent function but is never CALLED there - a dead guard is not a guard`);
  }
  console.log(`negation parity: ${names.length} guards present and called in the edge`);
}
