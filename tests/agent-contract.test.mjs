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

// Tools that legitimately never write a domain row. answer_question is the app
// replying to a question - it must stay out of WRITE_TOOLS, because a reply that
// quietly logged something would be the worst possible behaviour for a question.
const NON_WRITE = new Set(["request_user_review", "link_duplicate_candidates", "answer_question"]);

// 1. Every WRITE tool must have both an applyTool() case and a tableForTool() mapping.
for (const t of writeTools) {
  assert.ok(applyCases.includes(t), `WRITE tool "${t}" has no applyTool() case - high-confidence writes would silently vanish`);
  assert.ok(tableCases.includes(t), `WRITE tool "${t}" has no tableForTool() mapping - audit row would have a null table`);
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
//
// The two amendment tools take an extra argument the others do not: `_amend`,
// the plan the SERVER resolved against the closed set of rows on the day the
// user named. That is deliberate and is the whole safety property - the client
// may not re-resolve "the 30 g aloo bhujia" at confirm time, because it could
// land on a different row than the diff card the user was looking at. So the
// fixture supplies a resolved plan, exactly as the server would have.
const AMEND_PLAN = {
  amend_log_candidate: {
    op: "update", table: "food_logs", id: "row-1", kind: "food",
    before: { calories_estimate: 205 }, values: { calories_estimate: 430 }, columns: ["calories_estimate"],
  },
  delete_log_candidate: {
    op: "soft_delete", table: "food_logs", id: "row-1", kind: "food",
    before: { deleted_at: null }, values: {}, columns: ["deleted_at"],
  },
};
for (const t of APPLIER_WRITE_TOOLS) {
  const built = buildRowForTool(
    {
      tool_name: t,
      arguments: {
        amount: 1, value: 1, metric_type: "weight", description: "x", note: "n", occurred_at: "2026-01-01T00:00:00Z",
        ...(AMEND_PLAN[t] ? { target_ref: "x", target_kind: "food", _amend: AMEND_PLAN[t] } : {}),
      },
      confidence: 0.9,
    },
    "user-1",
  );
  assert.ok(built && typeof built.table === "string" && built.row, `buildRowForTool produced no row for write tool "${t}"`);
}
assert.equal(buildRowForTool({ tool_name: "request_user_review", arguments: {} }, "user-1"), null);

// 6b. An amendment with NO resolved plan builds nothing. It must never fall
//     through to the insert path - that would add a second row, which is the
//     exact bug amend_log_candidate exists to remove - and it must never be
//     reported as a write that happened.
for (const t of ["amend_log_candidate", "delete_log_candidate"]) {
  assert.equal(
    buildRowForTool({ tool_name: t, arguments: { target_ref: "30g aloo bhujia", target_kind: "food" } }, "user-1"),
    null,
    `${t} with an unresolved target must build nothing`,
  );
}
// ...and a resolved plan carries an `op`, so applyProposedAction can tell an
// amendment from an insert without knowing the tool names.
assert.equal(
  buildRowForTool({ tool_name: "amend_log_candidate", arguments: { _amend: AMEND_PLAN.amend_log_candidate } }, "user-1").op,
  "update",
);
assert.equal(
  buildRowForTool({ tool_name: "delete_log_candidate", arguments: { _amend: AMEND_PLAN.delete_log_candidate } }, "user-1").op,
  "soft_delete",
);

console.log(`agent contract tests passed: ${allowed.length} tools, ${writeTools.length} write tools wired server+client`);
