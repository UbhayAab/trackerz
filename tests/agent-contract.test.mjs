// Binds the edge function's tool allow-list to its apply switch so a tool can
// never again be accepted, validated, marked auto_applied, and then silently
// write nothing. Static analysis of supabase/functions/agent/index.ts (Deno TS,
// not importable from Node). Run from repo root.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPLIER_WRITE_TOOLS, buildRowForTool } from "../src/services/action-applier.js";

const src = readFileSync("supabase/functions/agent/index.ts", "utf8");

function setMembers(varName) {
  const m = src.match(new RegExp(`const ${varName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(m, `could not find ${varName} in index.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function caseLabels(fnSignature) {
  const body = src.match(new RegExp(`${fnSignature}[\\s\\S]*?\\n\\}`));
  assert.ok(body, `could not find function ${fnSignature}`);
  return [...body[0].matchAll(/case "([^"]+)":/g)].map((x) => x[1]);
}

const allowed = setMembers("ALLOWED_TOOLS");
const writeTools = setMembers("WRITE_TOOLS");
const applyCases = caseLabels("async function applyTool\\(");
const tableCases = caseLabels("function tableForTool\\(");
const schemaKeys = allowed.filter((t) => new RegExp(`\\b${t}: \\{`).test(src));

// Tools that legitimately never write a domain row.
const NON_WRITE = new Set(["request_user_review", "link_duplicate_candidates"]);

// 1. Every WRITE tool must have both an applyTool() case and a tableForTool() mapping.
for (const t of writeTools) {
  assert.ok(applyCases.includes(t), `WRITE tool "${t}" has no applyTool() case — high-confidence writes would silently vanish`);
  assert.ok(tableCases.includes(t), `WRITE tool "${t}" has no tableForTool() mapping — audit row would have a null table`);
}

// 2. Every allow-listed tool is classified: either a write tool or a known non-write tool.
for (const t of allowed) {
  assert.ok(writeTools.includes(t) || NON_WRITE.has(t), `allow-listed tool "${t}" is unclassified (add to WRITE_TOOLS or the non-write set)`);
}

// 3. WRITE_TOOLS must be a subset of ALLOWED_TOOLS (no orphan handlers).
for (const t of writeTools) {
  assert.ok(allowed.includes(t), `WRITE tool "${t}" is not in ALLOWED_TOOLS`);
}

// 4. Every allow-listed tool must have a validation schema.
for (const t of allowed) {
  assert.ok(schemaKeys.includes(t), `allow-listed tool "${t}" has no TOOL_SCHEMAS entry`);
}

// 5. The client-side applier (used when a user approves a proposed action) must
//    cover the SAME write tools as the server, or manual approvals would write
//    wrong/empty rows.
assert.deepEqual(
  [...writeTools].sort(),
  [...APPLIER_WRITE_TOOLS].sort(),
  "client APPLIER_WRITE_TOOLS is out of sync with the edge function's WRITE_TOOLS",
);

// 6. buildRowForTool returns a {table,row} for every write tool, and null for a
//    non-write tool.
for (const t of APPLIER_WRITE_TOOLS) {
  const built = buildRowForTool(
    { tool_name: t, arguments: { amount: 1, value: 1, metric_type: "weight", description: "x", note: "n", occurred_at: "2026-01-01T00:00:00Z" }, confidence: 0.9 },
    "user-1",
  );
  assert.ok(built && typeof built.table === "string" && built.row, `buildRowForTool produced no row for write tool "${t}"`);
}
assert.equal(buildRowForTool({ tool_name: "request_user_review", arguments: {} }, "user-1"), null);

console.log(`agent contract tests passed: ${allowed.length} tools, ${writeTools.length} write tools wired server+client`);
