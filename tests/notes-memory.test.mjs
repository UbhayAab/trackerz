// WS1 Jarvis memory & notes: the three new tools build the right rows (with
// upsert conflict targets for the keyed ones), and the additions feed surfaces
// notes + undoable AI target changes. Standalone node:assert.
import assert from "node:assert/strict";
import { buildRowForTool, APPLIER_WRITE_TOOLS } from "../src/services/action-applier.js";
import { buildAdditions } from "../lib/additions.mjs";

// --- new tools are write tools ---
for (const t of ["create_note_candidate", "set_target_candidate", "remember_fact"]) {
  assert.ok(APPLIER_WRITE_TOOLS.includes(t), `${t} missing from APPLIER_WRITE_TOOLS`);
}

// --- create_note_candidate -> notes (plain insert) ---
const note = buildRowForTool(
  { tool_name: "create_note_candidate", arguments: { body: "book dentist", kind: "todo", domain: "wellness", due_on: "2026-06-28", occurred_at: "2026-06-25T10:00:00Z" }, confidence: 0.9 },
  "u1",
);
assert.equal(note.table, "notes");
assert.ok(!note.conflictTarget, "notes is a plain insert, not an upsert");
assert.equal(note.row.body, "book dentist");
assert.equal(note.row.kind, "todo");
assert.equal(note.row.due_on, "2026-06-28");
assert.equal(note.row.user_id, "u1");

// --- set_target_candidate -> budgets (upsert by user_id,kind) ---
const target = buildRowForTool(
  { tool_name: "set_target_candidate", arguments: { kind: "daily_protein", amount: 180 }, confidence: 1 },
  "u1",
);
assert.equal(target.table, "budgets");
assert.equal(target.conflictTarget, "user_id,kind");
assert.equal(target.row.kind, "daily_protein");
assert.equal(target.row.amount, 180);
assert.equal(target.row.period, "daily", "daily_protein resolves to a daily budget period via goals.js");

const spendTarget = buildRowForTool(
  { tool_name: "set_target_candidate", arguments: { kind: "monthly_spend", amount: 40000 }, confidence: 1 },
  "u1",
);
assert.equal(spendTarget.row.period, "monthly");

// --- remember_fact -> memory_facts (upsert by user_id,key) ---
const fact = buildRowForTool(
  { tool_name: "remember_fact", arguments: { key: "usual_lunch", value: "egg curry + 2 rotis", kind: "preference", confidence: 0.8 }, confidence: 1 },
  "u1",
);
assert.equal(fact.table, "memory_facts");
assert.equal(fact.conflictTarget, "user_id,key");
assert.equal(fact.row.key, "usual_lunch");
assert.equal(fact.row.value, "egg curry + 2 rotis");
assert.equal(fact.row.kind, "preference");
assert.equal(fact.row.confidence, 0.8);

// --- additions feed shows notes + undoable target events ---
const items = buildAdditions([], [], [], {
  notes: [{ id: "n1", kind: "aspiration", body: "save 50k this month", domain: "money", status: "open", created_at: "2026-06-25T09:00:00Z" }],
  targetEvents: [{ id: "a1", action: "set_target", before: { kind: "monthly_spend", amount: 45000 }, after: { kind: "monthly_spend", amount: 40000 }, created_at: "2026-06-25T09:00:01Z" }],
});
const noteRow = items.find((i) => i.table === "notes");
assert.ok(noteRow, "note appears in the feed");
assert.equal(noteRow.domain, "note");
assert.equal(noteRow.status, "added");

const targetRow = items.find((i) => i.domain === "target");
assert.ok(targetRow, "target change appears in the feed");
assert.equal(targetRow.status, "target");
assert.equal(targetRow.undoId, "a1", "target row carries the audit id for one-tap undo");
assert.match(targetRow.delta, /45000.*40000/, "shows before -> after");

// --- a capture that fell back to review is VISIBLE in the feed (never lost) ---
const withReview = buildAdditions([], [], [], {
  reviewActions: [{
    id: "r1", tool_name: "request_user_review", created_at: "2026-06-25T12:00:00Z",
    arguments: { reason: "agent_error: timeout", raw_text: "spent 120 for mushroom sandwich and rose milk" },
  }],
});
const reviewRow = withReview.find((i) => i.domain === "review");
assert.ok(reviewRow, "a needs-review capture shows up in the feed");
assert.equal(reviewRow.status, "review");
assert.equal(reviewRow.table, "ai_actions");
assert.match(reviewRow.label, /mushroom sandwich/, "shows the raw captured text so it is never lost");

// archived notes are hidden
const hidden = buildAdditions([], [], [], { notes: [{ id: "n2", body: "old", status: "archived", created_at: "2026-06-25T09:00:00Z" }] });
assert.equal(hidden.find((i) => i.id === "n2"), undefined, "archived notes are not shown");

console.log("notes-memory tests passed");
