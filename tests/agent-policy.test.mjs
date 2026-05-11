import assert from "node:assert/strict";
import { decideActionPolicy } from "../src/agent/action-policy.js";
import { buildSystemBoundary } from "../src/agent/prompt-boundaries.js";
import { chooseModelRoute } from "../src/agent/model-router.js";

assert.equal(
  decideActionPolicy({
    name: "create_expense_candidate",
    confidence: 0.94,
    evidenceId: "ev_1",
  }).mode,
  "auto_apply",
);

assert.equal(
  decideActionPolicy({
    name: "create_expense_candidate",
    confidence: 0.91,
  }).mode,
  "review",
);

assert.equal(
  decideActionPolicy({
    name: "drop_all_tables",
    confidence: 1,
    evidenceId: "ev_1",
  }).mode,
  "block",
);

assert.equal(chooseModelRoute({ inputKind: "statement" }).extractor, "deterministic-parser");
assert.equal(chooseModelRoute({ inputKind: "image", risk: "high" }).extractor, "gemini-3.1-pro-preview");
assert.ok(buildSystemBoundary().includes("untrusted evidence"));

console.log("agent policy tests passed");
