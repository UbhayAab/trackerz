// TOOL SYNC - three-way drift guard over the AI tool surface.
//
// The app keeps its list of AI tools in three places that can never disagree:
//   1. src/agent/tool-registry.js       - the CLIENT's allowlist. getTool() feeds
//                                         decideActionPolicy(), so a name missing
//                                         here is blocked as "unknown_tool" and a
//                                         name present here is advertised as real.
//   2. ALLOWED_TOOLS in the edge fn     - what the SERVER will accept at all.
//                                         Anything else is dropped as unknown_tool
//                                         before validation.
//   3. applyTool()'s switch cases       - what the server can actually DO.
//
// This test fails the build when any pair drifts, plus asserts every tool name
// reaches the model through SYSTEM_PROMPT.
//
// It failed on the day it was written, which was the point. The registry listed
// `estimate_food_macros`, `apply_verified_action` and `undo_ai_action` with ZERO
// occurrences anywhere in supabase/functions/agent/index.ts - no ALLOWED_TOOLS
// entry, no TOOL_SCHEMAS entry, no applyTool case, no prompt text. Three
// capabilities the client advertised and the server would have rejected outright.
// The safer of the two fixes was taken: they were REMOVED from the registry
// rather than half-implemented, because a tool name that silently does nothing is
// worse than no tool name. See the comment at the top of tool-registry.js.
//
// tests/agent-contract.test.mjs already binds ALLOWED_TOOLS <-> WRITE_TOOLS <->
// applyTool on the server side; this test adds the CLIENT to that ring.
// Source-text extraction, same approach as tests/mirror-parity.test.mjs and
// tests/capture-idempotency.test.mjs (the Deno TS file is not importable here).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toolRegistry, isKnownTool, getTool } from "../src/agent/tool-registry.js";

const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");

// --- extractors --------------------------------------------------------------

function setMembers(varName) {
  const m = edge.match(new RegExp(`const ${varName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(m, `could not find ${varName} in supabase/functions/agent/index.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// applyTool is a long switch; take everything from its signature to the closing
// `default:` so a `case` in a nested helper below it cannot leak in.
function applyToolCases() {
  const start = edge.indexOf("async function applyTool(");
  assert.ok(start !== -1, "applyTool() not found in the edge function");
  const end = edge.indexOf("default:", start);
  assert.ok(end > start, "applyTool() has no default branch - an unhandled tool would fall through silently");
  return [...edge.slice(start, end).matchAll(/case "([^"]+)":/g)].map((x) => x[1]);
}

function systemPromptTemplate() {
  const start = edge.indexOf("const SYSTEM_PROMPT = `");
  assert.ok(start !== -1, "SYSTEM_PROMPT not found");
  const end = edge.indexOf("`;", start);
  assert.ok(end > start, "SYSTEM_PROMPT is not a closed template literal");
  return edge.slice(start, end);
}

const registryNames = toolRegistry.map((t) => t.name);
const allowed = setMembers("ALLOWED_TOOLS");
const writeTools = setMembers("WRITE_TOOLS");
const applyCases = applyToolCases();
const prompt = systemPromptTemplate();

const sorted = (xs) => [...new Set(xs)].sort();

// --- 1. registry <-> ALLOWED_TOOLS: exact set equality ------------------------
//
// Not "subset". A registry name the server rejects is a lie to the policy layer;
// a server name the registry does not know is blocked client-side as
// unknown_tool, so a legitimately emitted tool would be dropped on arrival.
assert.deepEqual(
  sorted(registryNames),
  sorted(allowed),
  "src/agent/tool-registry.js and ALLOWED_TOOLS have drifted. "
  + `only in registry: [${sorted(registryNames).filter((t) => !allowed.includes(t)).join(", ")}]; `
  + `only in ALLOWED_TOOLS: [${sorted(allowed).filter((t) => !registryNames.includes(t)).join(", ")}]`,
);

// No duplicate registrations - getTool() returns the first match, so a second
// entry with a different `write`/`destructive` flag would be dead but look live.
assert.equal(registryNames.length, new Set(registryNames).size, "duplicate tool name in the registry");

// --- 2. every tool the edge function accepts is one it can carry out ----------
//
// A write tool with no applyTool() case gets marked auto_applied with a null
// record id: the audit trail claims a row that does not exist. Non-write tools
// legitimately have no case (they carry information back, not a row).
const NON_WRITE = new Set(["request_user_review", "link_duplicate_candidates", "answer_question"]);
for (const name of allowed) {
  if (NON_WRITE.has(name)) {
    assert.ok(!applyCases.includes(name), `"${name}" is declared non-write but applyTool() has a case for it`);
    continue;
  }
  assert.ok(
    applyCases.includes(name),
    `allow-listed tool "${name}" has no applyTool() case - it would be accepted, validated, marked applied, and write nothing`,
  );
}

// And nothing handled by applyTool() is unreachable: a case for a tool the
// server never accepts is dead code that reads as a working feature.
for (const name of applyCases) {
  assert.ok(allowed.includes(name), `applyTool() handles "${name}" but ALLOWED_TOOLS rejects it - unreachable handler`);
}

// --- 3. the registry's write flags must match the server's -------------------
for (const tool of toolRegistry) {
  const serverWrites = writeTools.includes(tool.name);
  assert.equal(
    Boolean(tool.write),
    serverWrites,
    `registry says ${tool.name}.write=${Boolean(tool.write)} but the edge function's WRITE_TOOLS says ${serverWrites}`,
  );
}

// --- 4. every tool name actually reaches the model ---------------------------
//
// SYSTEM_PROMPT names the tools via `${[...ALLOWED_TOOLS].join(", ")}`, so the
// rendered prompt lists all of them even though only 12 of the 18 are also
// spelled out by hand in the rules. That interpolation is load-bearing: replace
// it with a hand-written list and the two drift on the next tool added. Assert
// BOTH - the interpolation is present, and the rendered prompt names every tool.
assert.ok(
  /Allowed tool names: \$\{\[\.\.\.ALLOWED_TOOLS\]\.join\(", "\)\}/.test(prompt),
  "SYSTEM_PROMPT no longer enumerates ALLOWED_TOOLS - tool names would have to be hand-maintained in the prompt",
);
const renderedPrompt = prompt.replace('${[...ALLOWED_TOOLS].join(", ")}', allowed.join(", "));
for (const name of allowed) {
  assert.ok(renderedPrompt.includes(name), `SYSTEM_PROMPT never names "${name}" - the model cannot emit a tool it was not told about`);
}

// --- 5. the three dead tools stay dead ---------------------------------------
//
// Regression lock on the day-one finding. If one of these ever comes back it
// must come back WIRED, and check 1 above will make that mandatory.
for (const dead of ["estimate_food_macros", "apply_verified_action", "undo_ai_action"]) {
  assert.ok(!isKnownTool(dead), `"${dead}" is back in the registry - wire it end to end or leave it out`);
  assert.equal(getTool(dead), null);
}

// --- 6. nothing destructive is registered ------------------------------------
//
// decideActionPolicy() blocks destructive tools, but only ones it knows about.
// There is no approve gate in this app: everything non-blocked auto-applies
// immediately, so a destructive tool arriving here is a one-way door.
for (const tool of toolRegistry) {
  assert.equal(tool.destructive, false, `destructive tool "${tool.name}" registered - there is no approve gate to catch it`);
  assert.ok(!/delete|drop|truncate|purge/i.test(tool.name), `tool "${tool.name}" reads as destructive`);
}

console.log(`tool sync tests passed: ${registryNames.length} tools agree across registry, ALLOWED_TOOLS, applyTool and SYSTEM_PROMPT`);
