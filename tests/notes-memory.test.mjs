// WS1 Jarvis memory & notes: the three new tools build the right rows (with
// upsert conflict targets for the keyed ones), and the additions feed surfaces
// notes + undoable AI target changes. Standalone node:assert.
import assert from "node:assert/strict";
import { buildRowForTool, APPLIER_WRITE_TOOLS } from "../src/services/action-applier.js";
import { buildAdditions } from "../lib/additions.mjs";
import { buildNotesView, provenanceLabel, FEED_LABEL_CHARS } from "../src/ui/notes-panel.js";

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

// ---------------------------------------------------------------------------
// THE READER. The feed above proves a note is ACKNOWLEDGED; it does not let the
// owner READ it - `label` is body.slice(0, 60) on one ellipsised line, and
// `memory_facts` had no surface in the app at all. buildNotesView is the shaping
// half of src/ui/notes-panel.js, which fixes both.
// ---------------------------------------------------------------------------
const LONG_NOTE = "When I am seen eating 6 boiled eggs daily, or protein powder daily with 500g curd or 500g milk, auto-add these to the Log again section so I do not retype them every day.";

// 1. The whole body survives, and the panel knows how much the feed was hiding.
{
  const view = buildNotesView({
    notes: [{ id: "n1", kind: "note", domain: "diet", status: "open", body: LONG_NOTE, occurred_at: "2026-08-04T11:16:05Z" }],
    memoryFacts: [],
  });
  assert.equal(view.notes.state, "ready");
  assert.equal(view.notes.rows[0].body, LONG_NOTE, "the panel keeps the FULL body, never a slice");
  assert.equal(view.notes.rows[0].hiddenChars, LONG_NOTE.length - FEED_LABEL_CHARS);
  assert.equal(view.truncatedInFeed, 1, "counts the notes the feed cuts off");
  assert.equal(view.notes.rows[0].kindLabel, "Note");
}

// 2. Newest first, and every kind gets a human label.
{
  const view = buildNotesView({
    notes: [
      { id: "old", kind: "aspiration", body: "a", occurred_at: "2026-08-01T00:00:00Z" },
      { id: "new", kind: "todo", body: "b", occurred_at: "2026-08-04T00:00:00Z" },
    ],
    memoryFacts: [],
  });
  assert.deepEqual(view.notes.rows.map((r) => r.id), ["new", "old"], "newest note first");
  assert.equal(view.notes.rows[0].kindLabel, "To do");
  assert.equal(view.notes.rows[1].kindLabel, "Aspiration");
}

// 3. THE ABSENT-DATA RULE. undefined (not synced), a failed read and a genuinely
//    empty table are three different states and must never print the same thing.
//    "0 notes" is a claim; it may only be made when the read actually succeeded.
{
  const loading = buildNotesView({});
  assert.equal(loading.notes.state, "loading");
  assert.equal(loading.facts.state, "loading");
  assert.ok(!/\b0\b/.test(loading.badge), `an unsynced panel must not claim a count, got "${loading.badge}"`);

  const failed = buildNotesView({ notes: [], memoryFacts: [], failedReads: ["notes: fetch failed", "memory: fetch failed"] });
  assert.equal(failed.notes.state, "failed", "a failed read is NOT an empty table");
  assert.equal(failed.facts.state, "failed");
  assert.match(failed.notes.reason, /fetch failed/, "the panel can say WHICH read died");
  assert.ok(!/\b0\b/.test(failed.badge), `a failed read must not be reported as zero, got "${failed.badge}"`);

  const empty = buildNotesView({ notes: [], memoryFacts: [] });
  assert.equal(empty.notes.state, "empty");
  assert.match(empty.badge, /0 notes/, "a real empty table may say zero");
}

// 4. memory_facts carries provenance, and the panel says who authored it. A fact
//    read out of a photograph must never look like one the owner typed.
{
  const view = buildNotesView({
    notes: [],
    memoryFacts: [
      { id: "f1", key: "daily_foods", value: "whey + 500g curd", kind: "pattern", confidence: 0.7, provenance: "typed", updated_at: "2026-08-06T01:45:41Z" },
      { id: "f2", key: "monthly_budget", value: "500000", kind: "fact", confidence: 0.9, provenance: "ocr", updated_at: "2026-08-06T01:45:41Z" },
      { id: "f3", key: "birthday", value: "19 October 2002", kind: "fact", confidence: 0.7, provenance: null, updated_at: "2026-08-07T09:15:57Z" },
    ],
  });
  assert.equal(view.facts.state, "ready");
  assert.equal(view.facts.rows[0].provenanceTone, "ok");
  assert.match(view.facts.rows[0].provenanceLabel, /you said it/);
  assert.equal(view.facts.rows[1].provenanceTone, "warn", "an OCR-sourced fact is flagged, not laundered");
  assert.match(view.facts.rows[1].provenanceLabel, /not from you/);
  // NULL predates the column. It must read as untracked, never as a measured
  // "unknown source" - that is the same absent-as-measured bug one layer down.
  assert.equal(view.facts.rows[2].provenanceTone, "neutral");
  assert.match(view.facts.rows[2].provenanceLabel, /before origins were tracked/);
  assert.match(view.badge, /3 facts/);
}

// 5. Provenance labels cover the whole closed set plus the two edges.
{
  assert.equal(provenanceLabel("voice").trust, "owner");
  assert.equal(provenanceLabel("sms").trust, "untrusted");
  assert.equal(provenanceLabel("calendar").trust, "untrusted");
  assert.equal(provenanceLabel("memory").trust, "derived");
  assert.equal(provenanceLabel("unknown").tone, "warn", "unattributed is shown as unattributed");
  assert.equal(provenanceLabel(undefined).trust, "untracked");
}

console.log("notes-memory tests passed");
