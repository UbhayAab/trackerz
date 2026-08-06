// Copies each pure mirror block from its lib/ source into the edge function that
// re-declares it (Deno cannot import repo-relative lib/), so the two never drift.
// tests/mirror-parity.test.mjs is the guard; this makes satisfying it a one-liner.
//
// Usage: node scripts/sync-mirror.mjs
import { readFileSync, writeFileSync } from "node:fs";

const JARVIS = "supabase/functions/jarvis/index.ts";
const AGENT = "supabase/functions/agent/index.ts";
const BLOCKS = [
  { lib: "lib/jarvis-brief.mjs", edge: JARVIS, start: "JARVIS-BRIEF MIRROR START", end: "JARVIS-BRIEF MIRROR END" },
  { lib: "lib/reminders.mjs", edge: JARVIS, start: "REMINDERS MIRROR START", end: "REMINDERS MIRROR END" },
  { lib: "lib/email-template.mjs", edge: JARVIS, start: "EMAIL-TEMPLATE MIRROR START", end: "EMAIL-TEMPLATE MIRROR END" },
  { lib: "lib/sleep-window.mjs", edge: AGENT, start: "SLEEP-WINDOW MIRROR START", end: "SLEEP-WINDOW MIRROR END" },
  { lib: "lib/route-invariants.mjs", edge: AGENT, start: "ROUTE-INVARIANTS MIRROR START", end: "ROUTE-INVARIANTS MIRROR END" },
  // Risk tiers. The edge is where auto-apply is DECIDED, so a drifted copy here
  // means the server commits something the client would have put behind a confirm
  // - the worst possible place for the two to disagree.
  { lib: "lib/mutation-risk.mjs", edge: AGENT, start: "MUTATION-RISK MIRROR START", end: "MUTATION-RISK MIRROR END" },
  { lib: "lib/schedule-args.mjs", edge: AGENT, start: "SCHEDULE-ARGS MIRROR START", end: "SCHEDULE-ARGS MIRROR END" },
  // "which row did they mean" and "which day did they mean". The edge is where an
  // amendment is RESOLVED - the browser never sees a row id and never should - so
  // a drifted copy here means the server edits a different row than the diff card
  // the user approved was describing. REFERENT-RESOLVER must be copied before
  // AMEND-TARGET reads it; both go after SCHEDULE-ARGS, whose zone helpers they
  // reuse rather than re-deriving.
  { lib: "lib/referent-resolver.mjs", edge: AGENT, start: "REFERENT-RESOLVER MIRROR START", end: "REFERENT-RESOLVER MIRROR END" },
  { lib: "lib/amend-target.mjs", edge: AGENT, start: "AMEND-TARGET MIRROR START", end: "AMEND-TARGET MIRROR END" },
  // Per-source capability bounds. The edge is where the model's output is turned
  // into rows, so this is the copy that decides whether a screenshot may rewrite
  // the standing plan. A drifted copy here means the server grants a capability
  // the client's own preview would have refused.
  { lib: "lib/provenance.mjs", edge: AGENT, start: "PROVENANCE MIRROR START", end: "PROVENANCE MIRROR END" },
  // The untrusted-input policy and the injection lexicon. This one is not lib/:
  // the source of truth is the browser module, which had its regexes hand-copied
  // into the edge function for months and its five policy sentences copied
  // nowhere at all - SYSTEM_PROMPT did not contain a word of them until they
  // became a mirror block that the prompt is literally built from.
  { lib: "src/agent/prompt-boundaries.js", edge: AGENT, start: "PROMPT-BOUNDARY MIRROR START", end: "PROMPT-BOUNDARY MIRROR END" },
];

function block(src, file, START, END) {
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s < 0 || e < 0) throw new Error(`mirror markers missing in ${file}`);
  const lineStart = src.lastIndexOf("\n", s) + 1;
  const lineEnd = src.indexOf("\n", e) + 1;
  return { body: src.slice(lineStart, lineEnd), lineStart, lineEnd };
}

// Group blocks by their edge target so each file is read + written once.
const byEdge = new Map();
for (const b of BLOCKS) {
  if (!byEdge.has(b.edge)) byEdge.set(b.edge, []);
  byEdge.get(b.edge).push(b);
}

let totalChanged = 0;
for (const [edgeFile, blocks] of byEdge) {
  let edge = readFileSync(edgeFile, "utf8");
  let changed = 0;
  for (const { lib: LIB, start: START, end: END } of blocks) {
    const libBlock = block(readFileSync(LIB, "utf8"), LIB, START, END);
    const edgeBlock = block(edge, edgeFile, START, END);

    // Only the marker comment lines differ (each names the other file); rebuild
    // the edge block from the lib body with the edge's own markers restored.
    const libLines = libBlock.body.split("\n");
    const edgeLines = edgeBlock.body.split("\n");
    libLines[0] = edgeLines[0];
    libLines[libLines.length - 2] = edgeLines[edgeLines.length - 2];

    const next = edge.slice(0, edgeBlock.lineStart) + libLines.join("\n") + edge.slice(edgeBlock.lineEnd);
    if (next !== edge) {
      edge = next;
      changed += 1;
      console.log(`synced ${libLines.length} lines from ${LIB} -> ${edgeFile}`);
    }
  }
  if (changed) { writeFileSync(edgeFile, edge); totalChanged += changed; }
}

// --- derived arrays ---------------------------------------------------------
// FOOD_WORDS is no longer a literal in lib/ - it is derived from the nutrition
// table at import time, so it cannot be copied as text. Regenerate the edge's
// literal from the lib's RUNTIME value instead. This is what stops a food added
// to food-nutrition.mjs from staying invisible to the edge function's salvage.
{
  const { FOOD_WORDS } = await import("../lib/fan-out-expander.mjs");
  let edge = readFileSync(AGENT, "utf8");
  const rx = /^const FOOD_WORDS = \[[\s\S]*?\];$/m;
  if (!rx.test(edge)) throw new Error(`FOOD_WORDS literal not found in ${AGENT}`);
  const next = edge.replace(rx, `const FOOD_WORDS = ${JSON.stringify([...FOOD_WORDS].sort())};`);
  if (next !== edge) {
    writeFileSync(AGENT, next);
    totalChanged += 1;
    console.log(`regenerated FOOD_WORDS (${FOOD_WORDS.length} terms) -> ${AGENT}`);
  }
}

// FOOD_TABLE + FOOD_STOPWORDS, for the same reason and by the same method.
//
// These two were HAND-COPIED into the edge function and drifted the moment
// lib/food-nutrition.mjs was edited: on 2026-08-06 the lib grew `aloo bhujia`,
// `instant soup` and seven other entries and the edge did not, so the server -
// which is the copy whose totals actually reach the user, because it overrides
// the model - kept pricing a 50 g bhujia snack off a model guess. Nothing
// detected it except tests/food-mirror.test.mjs, and only for one phrase.
//
// The edge's shape is a subset of the lib's: no `category` and no `unit`, both of
// which exist for the browser's own UI and are dead weight in Deno. Regenerating
// rather than copying is what makes "add a food and re-run sync-mirror" true of
// the TABLE and not only of the salvage cue list derived from it.
{
  const { FOOD_TABLE } = await import("../lib/food-nutrition.mjs");
  // STOPWORDS is module-private in lib/food-nutrition.mjs, so it is read out of
  // the SOURCE rather than imported. Extraction, not a second copy: the literal
  // in the edge is rebuilt from the literal in the lib on every sync, which is
  // the same guarantee an import would give.
  const libFood = readFileSync("lib/food-nutrition.mjs", "utf8");
  const stopStart = libFood.indexOf("const STOPWORDS = new Set([");
  const stopEnd = libFood.indexOf("]);", stopStart);
  if (stopStart < 0 || stopEnd < 0) throw new Error("STOPWORDS literal not found in lib/food-nutrition.mjs");
  const STOPWORDS = new Set(
    [...libFood.slice(stopStart, stopEnd).matchAll(/"([^"]*)"/g)].map((m) => m[1]),
  );
  let edge = readFileSync(AGENT, "utf8");

  // Emitted in the edge's own hand-written style - `{ key: "egg", kind: ... }` -
  // rather than as JSON, because tests/food-mirror.test.mjs reads both tables
  // with the same regex and a generator that produced a different shape would
  // pass the numeric corpus while the structural checks silently matched nothing.
  const rows = FOOD_TABLE.map((e) => {
    const parts = [];
    for (const [k, v] of Object.entries(e)) {
      if (k === "category" || k === "unit") continue; // browser-only fields
      parts.push(`${k}: ${JSON.stringify(v).replace(/","/g, '", "')}`);
    }
    return `  { ${parts.join(", ")} },`;
  }).join("\n");
  const tableRx = /^const FOOD_TABLE: any\[\] = \[[\s\S]*?^\];$/m;
  if (!tableRx.test(edge)) throw new Error(`FOOD_TABLE literal not found in ${AGENT}`);
  edge = edge.replace(tableRx, `const FOOD_TABLE: any[] = [\n${rows}\n];`);

  const stopRx = /^const FOOD_STOPWORDS = new Set<string>\(\[[\s\S]*?\]\);$/m;
  if (!stopRx.test(edge)) throw new Error(`FOOD_STOPWORDS literal not found in ${AGENT}`);
  edge = edge.replace(stopRx, `const FOOD_STOPWORDS = new Set<string>(${JSON.stringify([...STOPWORDS])});`);

  const before = readFileSync(AGENT, "utf8");
  if (edge !== before) {
    writeFileSync(AGENT, edge);
    totalChanged += 1;
    console.log(`regenerated FOOD_TABLE (${FOOD_TABLE.length} foods) + FOOD_STOPWORDS (${STOPWORDS.size} words) -> ${AGENT}`);
  }
}

console.log(totalChanged ? `wrote ${totalChanged} block(s)` : "mirrors already in sync");
