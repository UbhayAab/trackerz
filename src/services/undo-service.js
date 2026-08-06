// UNDO SERVICE - the only place that turns an undo plan into writes.
//
// `scripts/capture.mjs --undo <ingestionId>` has done a crude version of this for
// a while: sweep nine tables, hard-delete anything carrying that ingestion_id,
// then delete the ai_actions and ai_runs rows too. That works for a diagnostic
// run and is wrong for a user-facing undo in three ways, all of which this fixes:
//
//   1. It hard-deletes. Nothing can be recovered, and undoing an undo is
//      impossible. Here every removal is a tombstone (deleted_at), which is what
//      makes the reversal itself reversible.
//   2. It deletes the ai_actions rows, so afterwards there is no record that the
//      capture ever happened or that it was undone - the same self-erasing audit
//      trail that revertTargetEvent used to have. Here the action is marked
//      `reverted` and keeps its payload.
//   3. It reports one number for the whole sweep. If four rows come off and one
//      is already gone, "undone" is a lie about the fifth. Every result here is
//      PER ACTION: { undone, failed: [{actionId, reason}], alreadyUndone }.
//
// Two cases that must never be errors, because they are both normal:
//   * Undoing an already-undone action is a NO-OP reported as `alreadyUndone`.
//   * Undoing a row someone deleted out of band reports `target_missing` and
//     writes NOTHING - it must never re-insert a phantom from the before-image.

import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import {
  undoPlan, normalizeUndoPayload, describeUndo, SOFT_DELETABLE_TABLES,
} from "../../lib/undo-ledger.mjs";

function requireUserId() {
  const session = getCurrentSession();
  if (!session?.user?.id) throw new Error("not_authenticated");
  return session.user.id;
}

const SOFT = new Set(SOFT_DELETABLE_TABLES);

// The ONE table an undo may hard-delete from, and only when reversing a row the
// AI created. `budgets` is a single canonical row per (user, kind) with no
// tombstone column - it is a setting, not an event log - so "undo the target the
// AI invented" means removing that row. Everything else must be soft-deletable.
const HARD_UNDO_TABLES = new Set(["budgets"]);

async function rowExists(supabase, table, id, userId) {
  const { data, error } = await supabase
    .from(table).select("id, deleted_at").eq("id", id).eq("user_id", userId).limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

// Execute one inverted step. Returns { ok } | { alreadyUndone } | { reason }.
async function runStep(supabase, userId, step) {
  const { op, table, id } = step;
  if (!table || !id) return { reason: "no_target_row" };

  if (op === "soft_delete") {
    if (!SOFT.has(table)) {
      if (!HARD_UNDO_TABLES.has(table)) return { reason: `not_soft_deletable:${table}` };
      const existing = await rowExists(supabase, table, id, userId);
      if (!existing) return { reason: "target_missing" };
      const { error } = await supabase.from(table).delete().eq("id", id).eq("user_id", userId);
      if (error) return { reason: error.message };
      return { ok: true };
    }
    const { data, error } = await supabase
      .from(table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", userId).is("deleted_at", null)
      .select("id");
    if (error) return { reason: error.message };
    if ((data || []).length) return { ok: true };
    // Nothing updated: either the row is already tombstoned (fine, no-op) or it
    // is not there at all (report it - do not claim an undo that never happened).
    const existing = await rowExists(supabase, table, id, userId);
    if (!existing) return { reason: "target_missing" };
    return { alreadyUndone: true };
  }

  if (op === "restore") {
    const existing = await rowExists(supabase, table, id, userId);
    // A row hard-deleted out of band cannot be restored, and re-inserting the
    // before-image would create a PHANTOM: a row with the old id gone, carrying
    // stale values, that nothing else in the app references.
    if (!existing) return { reason: "target_missing" };
    if (!existing.deleted_at) return { alreadyUndone: true };
    const { error } = await supabase
      .from(table).update({ deleted_at: null }).eq("id", id).eq("user_id", userId);
    if (error) return { reason: error.message };
    return { ok: true };
  }

  if (op === "update") {
    const existing = await rowExists(supabase, table, id, userId);
    if (!existing) return { reason: "target_missing" };
    if (!step.columns?.length) return { reason: "no_columns_recorded" };
    // NAMED COLUMNS ONLY. Writing the whole before-image back would clobber every
    // legitimate edit made between the write and this undo.
    const { error } = await supabase
      .from(table).update(step.values).eq("id", id).eq("user_id", userId);
    if (error) return { reason: error.message };
    return { ok: true };
  }

  return { reason: step.reason || "not_undoable" };
}

async function markReverted(supabase, actionId, payload) {
  const next = { ...(payload || {}), undone_at: new Date().toISOString() };
  const { error } = await supabase
    .from("ai_actions")
    .update({ status: "reverted", undo_payload: next })
    .eq("id", actionId);
  if (error) throw error;
}

// Execute an undo plan against the DB. Shared by undoIngestion and undoAction so
// there is exactly one implementation of "what does undoing look like".
async function executePlan(plan) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const undone = [];
  const failed = [...plan.skipped];
  const alreadyUndone = [...plan.alreadyUndone];

  for (const step of plan.steps) {
    let result;
    try {
      result = await runStep(supabase, userId, step);
    } catch (err) {
      result = { reason: err?.message || String(err) };
    }
    if (result.ok) {
      try {
        await markReverted(supabase, step.actionId, step.payload);
      } catch (err) {
        // The row came off but the ledger did not record it. Say so - a silent
        // mismatch here is how an action stays "auto_applied" against a row that
        // no longer exists (the dangling-undo-button bug from AUDIT-2026-07-24).
        failed.push({ actionId: step.actionId, reason: `undone_but_unmarked:${err?.message || err}` });
        continue;
      }
      undone.push({ actionId: step.actionId, table: step.table, id: step.id, what: describeUndo(step.payload) });
    } else if (result.alreadyUndone) {
      try { await markReverted(supabase, step.actionId, step.payload); } catch { /* status is cosmetic here */ }
      alreadyUndone.push({ actionId: step.actionId, reason: "already_undone" });
    } else {
      failed.push({ actionId: step.actionId, reason: result.reason });
    }
  }
  return { undone, failed, alreadyUndone, ok: failed.length === 0 };
}

// Undo everything one capture wrote. Never returns a blanket "undone" - the
// caller gets the exact per-action breakdown so the toast can say "3 removed, 1
// was already gone" instead of a confident lie.
export async function undoIngestion(ingestionId) {
  if (!ingestionId) throw new Error("undoIngestion needs an ingestionId");
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("ai_actions")
    .select("id, tool_name, status, applied_record_table, applied_record_id, undo_payload, applied_at, created_at")
    .eq("ingestion_id", ingestionId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const actions = (data || []).filter((a) => a.status !== "rejected" || a.applied_record_id);
  if (!actions.length) return { undone: [], failed: [], alreadyUndone: [], ok: true, empty: true };
  return executePlan(undoPlan(actions));
}

// Undo a single applied action (the feed's per-row undo, and the 15-second toast
// behind a soft-confirmed plan delta).
export async function undoAction(actionId) {
  if (!actionId) throw new Error("undoAction needs an actionId");
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("ai_actions")
    .select("id, tool_name, status, applied_record_table, applied_record_id, undo_payload, applied_at, created_at")
    .eq("id", actionId)
    .limit(1);
  if (error) throw error;
  const action = (data || [])[0];
  if (!action) return { undone: [], failed: [{ actionId, reason: "action_missing" }], alreadyUndone: [], ok: false };
  return executePlan(undoPlan([action]));
}

// What an undo WOULD do, without doing it. Feeds the confirm toast's label.
export function previewUndo(action) {
  return describeUndo(normalizeUndoPayload(action?.undo_payload));
}

export default undoIngestion;
