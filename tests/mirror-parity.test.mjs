// MIRROR-PARITY GUARD — the anti-drift backbone of the AI engine.
//
// The Deno edge function (supabase/functions/agent/index.ts) cannot import repo
// lib/, so it HAND-COPIES every deterministic guard (lexicons, regexes, intent
// logic). Those copies silently drift — that is exactly what produced a duplicate
// eat-vs-buy implementation and a 14-term gap in looksLikeGym. This test fails the
// build the moment a lib source-of-truth and its inline edge twin diverge.
//
// Strategy: statically extract the named array/regex literals from BOTH files and
// assert equality; for representations that differ (lib arrays vs edge regexes for
// gym), assert BEHAVIORAL agreement over a corpus.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksLikeGym } from "../lib/capture-intent.mjs";

const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
const fanout = readFileSync("lib/fan-out-expander.mjs", "utf8");
const router = readFileSync("lib/request-router.mjs", "utf8");
const negation = readFileSync("lib/negation.mjs", "utf8");

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
  ["FOOD_MERCHANTS", fanout], ["FOOD_WORDS", fanout], ["MONTHS", fanout],
  ["PLAN_CHANGE_CUES", router], ["BUDGET_CHANGE_CUES", router],
  ["QUERY_CUES", router], ["LOG_OVERRIDE_CUES", router],
]) {
  assertSameSet(name, stringArray(libSrc, name), stringArray(edge, name));
}

// --- 2. regex mirrors (same const name in lib + edge) -----------------------
for (const [name, libSrc] of [
  ["MONEY_CUE", fanout], ["MONEY_SUFFIX", fanout], ["MONEY_TRAIL", fanout],
  ["PURCHASE_CUE", fanout], ["FOR_LATER_CUE", fanout], ["CONSUMPTION_CUE", fanout],
  ["NEGATION_RE", negation], ["CLAUSE_SPLIT_RE", negation],
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
