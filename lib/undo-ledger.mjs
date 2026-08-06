// UNDO LEDGER - the record that makes a write reversible, and the plan that
// reverses it.
//
// Why v2 exists. Every `ai_actions.undo_payload` ever written is one of
// `{table, id}` (an insert), `{errors}`, `{error}` or `{review_reason}`. That is
// exactly enough to delete an insert and useless for anything else: an EDIT has
// no record of what the value used to be, so "undo" would have nothing to put
// back, and a DELETE has no record that the row existed at all. Shipping edit and
// delete tools on top of a v1 payload would leave the app strictly worse than it
// is today, because today the only thing the model can do is add a row the user
// can remove.
//
// v2 shape:
//   { v: 2, op: "insert"|"update"|"delete"|"upsert", table, id, before, after, columns }
//
// The rule that matters most: an `update` undo restores ONLY the named
// `columns`. Restoring the whole `before` row would clobber every later
// legitimate edit made between the write and the undo - the user corrects the
// calories at 14:00, the app rewrites the description at 15:00, and an undo of
// the 14:00 action at 16:00 would silently roll the 15:00 change back too. Proved
// by an interleaving test in tests/undo-ledger.test.mjs.
//
// Pure: no DOM, no Supabase. src/services/undo-service.js is the only thing that
// turns these steps into writes.

export const UNDO_PAYLOAD_VERSION = 2;

// Every table the LLM can reach. These carry `deleted_at timestamptz`; reads
// filter `.is("deleted_at", null)` and a hard delete only ever happens in the
// 30-day purge. The model gets NO hard-delete path at any risk tier - a delete it
// asks for is a tombstone, which is what makes "undo the delete" possible at all.
export const SOFT_DELETABLE_TABLES = [
  "ledger_entries", "food_logs", "workout_logs", "hydration_logs", "sleep_sessions",
  "body_metrics", "wellness_logs", "notes", "reminders", "user_plans", "memory_facts",
];

// How long a tombstone survives before the purge may hard-delete it.
export const PURGE_AFTER_DAYS = 30;

// Columns an undo must never write back. `id` and `user_id` identify the row (a
// restore that rewrote them would move the row to another user); `created_at`
// and `ingestion_id` are provenance, not state.
const NEVER_RESTORE = new Set(["id", "user_id", "created_at", "ingestion_id"]);

const OPS = new Set(["insert", "update", "delete", "upsert"]);

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// Build a v2 payload. Callers pass whatever they have; this is the ONE place the
// shape is decided, so a writer cannot invent a fourth spelling of it.
export function undoPayloadFor({ op, table, id, before = null, after = null, columns = null, note = null } = {}) {
  const payload = {
    v: UNDO_PAYLOAD_VERSION,
    op: OPS.has(op) ? op : "insert",
    table: table || null,
    id: id || null,
    before: isPlainObject(before) ? before : null,
    after: isPlainObject(after) ? after : null,
    columns: Array.isArray(columns) ? columns.filter((c) => typeof c === "string" && !NEVER_RESTORE.has(c)) : [],
  };
  if (note) payload.note = note;
  return payload;
}

// Read any historical payload as v2. A v1 `{table, id}` was ALWAYS an insert -
// that is the only op the app has ever performed - so it upgrades losslessly and
// every row already in ai_actions stays undoable. `{errors}` / `{error}` /
// `{review_reason}` describe a write that never happened; they normalize to null.
export function normalizeUndoPayload(payload) {
  if (!isPlainObject(payload)) return null;
  if (payload.v === UNDO_PAYLOAD_VERSION || OPS.has(payload.op)) {
    return undoPayloadFor({
      op: payload.op,
      table: payload.table,
      id: payload.id,
      before: payload.before,
      after: payload.after,
      columns: payload.columns,
      note: payload.note || null,
    });
  }
  if (payload.table && payload.id) {
    return undoPayloadFor({ op: "insert", table: payload.table, id: payload.id, note: payload.note || null });
  }
  return null;
}

// The columns an update/upsert undo is allowed to touch. Explicit `columns` win;
// otherwise the keys the write itself set (`after`) are what it changed, so those
// are what it may put back. Never the whole row.
export function undoColumns(payload) {
  const p = normalizeUndoPayload(payload);
  if (!p) return [];
  if (p.columns.length) return p.columns;
  if (isPlainObject(p.after)) return Object.keys(p.after).filter((c) => !NEVER_RESTORE.has(c));
  return [];
}

export function isUndoable(payload) {
  const p = normalizeUndoPayload(payload);
  if (!p || !p.table || !p.id) return false;
  if (p.op === "insert") return true;
  if (p.op === "delete") return true;
  // An update with no before-image cannot be reversed: there is nothing to put
  // back, and guessing is how an undo becomes a second wrong edit.
  if (p.op === "update") return isPlainObject(p.before) && undoColumns(p).length > 0;
  // An upsert that CREATED the row (no before) reverses by tombstoning it; one
  // that replaced a row reverses by restoring the named columns.
  if (p.op === "upsert") return p.before == null || undoColumns(p).length > 0;
  return false;
}

// Why a payload cannot be undone, in a word the UI can show. Never "failed".
export function undoBlockReason(payload) {
  const p = normalizeUndoPayload(payload);
  if (!p) return "no_undo_record";
  if (!p.table || !p.id) return "no_target_row";
  if ((p.op === "update" || p.op === "upsert") && !undoColumns(p).length) return "no_columns_recorded";
  if (p.op === "update" && !isPlainObject(p.before)) return "no_before_image";
  return "not_undoable";
}

function pick(source, columns) {
  const out = {};
  for (const c of columns) {
    if (NEVER_RESTORE.has(c)) continue;
    out[c] = isPlainObject(source) && c in source ? source[c] : null;
  }
  return out;
}

// Turn a payload into the single write that reverses it.
//   insert  -> soft_delete (tombstone the row it added)
//   upsert with no prior row -> soft_delete, same reasoning
//   update / upsert over a prior row -> update, NAMED COLUMNS ONLY
//   delete  -> restore (clear the tombstone). Deliberately NOT a re-insert: a row
//              hard-deleted out of band must report target_missing, never be
//              resurrected as a phantom carrying a stale before-image.
export function invert(payload) {
  const p = normalizeUndoPayload(payload);
  if (!p || !isUndoable(p)) {
    return { op: "none", table: p?.table || null, id: p?.id || null, reason: undoBlockReason(payload) };
  }
  if (p.op === "insert" || (p.op === "upsert" && p.before == null)) {
    return { op: "soft_delete", table: p.table, id: p.id, values: null, columns: [] };
  }
  if (p.op === "delete") {
    return { op: "restore", table: p.table, id: p.id, values: { deleted_at: null }, columns: ["deleted_at"] };
  }
  const columns = undoColumns(p);
  return { op: "update", table: p.table, id: p.id, values: pick(p.before, columns), columns };
}

function timeOf(action) {
  const t = new Date(action?.applied_at || action?.created_at || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// An action that has already been reversed. Undoing it again is a NO-OP that
// reports `alreadyUndone` - never an error, because the honest answer to "undo
// this" when it is already undone is "it already is".
export function isAlreadyUndone(action) {
  const status = String(action?.status || "").toLowerCase();
  if (status === "reverted" || status === "undone" || status === "rejected") return true;
  return Boolean(action?.undo_payload && action.undo_payload.undone_at);
}

// Order a set of actions into the writes that reverse them.
//
// Reverse-chronological, because a later action may depend on an earlier one
// (the second edit of a row has to come off before the first). Then DELETES
// before INSERTS/restores within that order: tombstoning the rows that reference
// something has to happen before anything that puts a referenced row back, and a
// restore that lands first can be immediately re-tombstoned by a later step.
// Array.prototype.sort is stable, so the reverse-chronological order survives the
// partition.
export function undoPlan(actions = []) {
  const rows = (Array.isArray(actions) ? actions : []).filter(Boolean).slice().sort((a, b) => timeOf(b) - timeOf(a));
  const steps = [];
  const alreadyUndone = [];
  const skipped = [];
  for (const action of rows) {
    if (isAlreadyUndone(action)) {
      alreadyUndone.push({ actionId: action.id, reason: "already_undone" });
      continue;
    }
    const payload = normalizeUndoPayload(action.undo_payload);
    if (!isUndoable(payload)) {
      skipped.push({ actionId: action.id, reason: undoBlockReason(action.undo_payload) });
      continue;
    }
    steps.push({ actionId: action.id, payload, ...invert(payload) });
  }
  const rank = (s) => (s.op === "soft_delete" ? 0 : 1);
  steps.sort((a, b) => rank(a) - rank(b));
  return { steps, alreadyUndone, skipped };
}

const TABLE_NOUN = {
  ledger_entries: "money entry", food_logs: "food log", workout_logs: "workout",
  hydration_logs: "water log", sleep_sessions: "sleep session", body_metrics: "body metric",
  wellness_logs: "wellness note", notes: "note", reminders: "reminder",
  user_plans: "plan", memory_facts: "remembered fact", budgets: "target",
};

function noun(table) {
  return TABLE_NOUN[table] || String(table || "row").replace(/_/g, " ");
}

// One plain sentence for the confirm toast / diff card footer. Says what the undo
// will DO, not what the action did - the user is deciding about the undo.
export function describeUndo(payload) {
  const p = normalizeUndoPayload(payload);
  if (!p) return "Nothing to undo.";
  const step = invert(p);
  if (step.op === "soft_delete") return `Remove the ${noun(p.table)} it added.`;
  if (step.op === "restore") return `Put the deleted ${noun(p.table)} back.`;
  if (step.op === "update") {
    const cols = step.columns;
    const shown = cols.slice(0, 3).map((c) => c.replace(/_/g, " ")).join(", ");
    const rest = cols.length > 3 ? ` and ${cols.length - 3} more` : "";
    return `Put ${shown}${rest} on the ${noun(p.table)} back to what it was.`;
  }
  return "Nothing to undo.";
}
