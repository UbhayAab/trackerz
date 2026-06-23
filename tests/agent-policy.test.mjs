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

// No approve gate any more: a non-blocked action auto-commits even without an
// evidenceId. The `reasons` still carry the flag so the UI can mark it.
const lowEvidence = decideActionPolicy({
  name: "create_expense_candidate",
  confidence: 0.91,
});
assert.equal(lowEvidence.mode, "auto_apply");
assert.ok(lowEvidence.reasons.includes("missing_evidence"));

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
