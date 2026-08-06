// UNDO LEDGER - the record that makes a write reversible, and the plan that
// reverses it.
import assert from "node:assert/strict";
import {
  UNDO_PAYLOAD_VERSION, SOFT_DELETABLE_TABLES, PURGE_AFTER_DAYS,
  undoPayloadFor, normalizeUndoPayload, undoColumns, isUndoable, undoBlockReason,
  invert, undoPlan, describeUndo, isAlreadyUndone,
} from "../lib/undo-ledger.mjs";

// ---- shape -----------------------------------------------------------------
{
  const p = undoPayloadFor({ op: "insert", table: "food_logs", id: "f1" });
  assert.equal(p.v, 2);
  assert.equal(UNDO_PAYLOAD_VERSION, 2);
  assert.equal(p.op, "insert");
  assert.equal(p.before, null);
  assert.deepEqual(p.columns, []);
  // An unknown op is not a licence to invent one.
  assert.equal(undoPayloadFor({ op: "obliterate", table: "x", id: "1" }).op, "insert");
  // id / user_id / created_at can never be restored, so they never enter `columns`.
  assert.deepEqual(
    undoPayloadFor({ op: "update", table: "budgets", id: "b1", before: { amount: 1 }, columns: ["amount", "id", "user_id", "created_at"] }).columns,
    ["amount"],
  );
}

// ---- v1 upgrade ------------------------------------------------------------
// Every undo_payload ever written is `{table,id}` / `{errors}` / `{error}` /
// `{review_reason}`. The first shape was ALWAYS an insert, so it upgrades
// losslessly and every historical row stays undoable.
{
  const v1 = normalizeUndoPayload({ table: "food_logs", id: "f9" });
  assert.equal(v1.v, 2);
  assert.equal(v1.op, "insert");
  assert.equal(isUndoable(v1), true);
  // A v1 row that also carried the low_evidence tag keeps it.
  assert.equal(normalizeUndoPayload({ table: "notes", id: "n1", note: "low_evidence" }).note, "low_evidence");
  // These describe a write that never happened.
  for (const dead of [{ errors: ["required:amount"] }, { error: "boom" }, { review_reason: "low_evidence" }, null, "x", []]) {
    assert.equal(normalizeUndoPayload(dead), null, JSON.stringify(dead));
    assert.equal(isUndoable(dead), false);
  }
  assert.equal(undoBlockReason({ errors: ["x"] }), "no_undo_record");
}

// ---- invert ----------------------------------------------------------------
{
  // An insert is undone by TOMBSTONING, never by a hard delete - that is what
  // makes undoing the undo possible.
  const ins = invert(undoPayloadFor({ op: "insert", table: "food_logs", id: "f1" }));
  assert.equal(ins.op, "soft_delete");
  assert.equal(ins.table, "food_logs");
  assert.equal(ins.id, "f1");

  // An upsert that CREATED the row behaves like an insert.
  const created = invert(undoPayloadFor({ op: "upsert", table: "budgets", id: "b1", before: null }));
  assert.equal(created.op, "soft_delete");

  // An upsert OVER an existing row is an EDIT: undo restores the prior value, it
  // does not delete a budget the user had before the AI ever spoke.
  const edited = invert(undoPayloadFor({
    op: "upsert", table: "budgets", id: "b1",
    before: { id: "b1", kind: "daily_protein", amount: 150, period: "daily" },
    columns: ["amount", "period"],
  }));
  assert.equal(edited.op, "update");
  assert.deepEqual(edited.values, { amount: 150, period: "daily" });
  assert.deepEqual(edited.columns, ["amount", "period"]);
  assert.ok(!("kind" in edited.values), "the key column is not restored");
  assert.ok(!("id" in edited.values), "the id is never restored");

  // A delete is undone by CLEARING the tombstone - never by re-inserting the
  // before-image, which would be a phantom row.
  const del = invert(undoPayloadFor({ op: "delete", table: "notes", id: "n1", before: { body: "gone" } }));
  assert.equal(del.op, "restore");
  assert.deepEqual(del.values, { deleted_at: null });
}

// ---- an update with nothing to put back is NOT undoable ---------------------
{
  const noBefore = undoPayloadFor({ op: "update", table: "food_logs", id: "f1", after: { calories_estimate: 400 } });
  assert.equal(isUndoable(noBefore), false);
  assert.equal(undoBlockReason(noBefore), "no_before_image");
  assert.equal(invert(noBefore).op, "none");
  // No table/id at all.
  assert.equal(isUndoable(undoPayloadFor({ op: "insert" })), false);
  assert.equal(undoBlockReason(undoPayloadFor({ op: "insert" })), "no_target_row");
}

// ---- columns fall back to what the write actually SET, never the whole row ---
{
  const p = undoPayloadFor({
    op: "update", table: "food_logs", id: "f1",
    before: { calories_estimate: 300, protein_g: 20, description: "6 eggs", meal_slot: "lunch" },
    after: { calories_estimate: 400 },
  });
  assert.deepEqual(undoColumns(p), ["calories_estimate"]);
  assert.deepEqual(invert(p).values, { calories_estimate: 300 }, "only the column the write touched");
}

// ---------------------------------------------------------------------------
// THE INTERLEAVING PROOF. This is the reason an update undo restores only the
// NAMED columns.
//
//   14:00  the AI corrects calories        300 -> 400   (action A)
//   15:00  the user rewrites the description            (a later, legitimate edit)
//   16:00  the user undoes action A
//
// Restoring the whole `before` row at 16:00 would silently roll the 15:00 change
// back too - an undo of one thing quietly undoing another.
// ---------------------------------------------------------------------------
{
  const rowAt1400Before = { id: "f1", description: "6 eggs", calories_estimate: 300, protein_g: 36, meal_slot: "lunch" };
  const actionA = undoPayloadFor({
    op: "update", table: "food_logs", id: "f1",
    before: rowAt1400Before,
    after: { calories_estimate: 400 },
    columns: ["calories_estimate"],
  });

  // 15:00 - an unrelated edit lands on the same row.
  const rowAt1500 = { ...rowAt1400Before, calories_estimate: 400, description: "6 boiled eggs and curd", protein_g: 47 };

  // 16:00 - undo action A.
  const step = invert(actionA);
  const rowAfterUndo = { ...rowAt1500, ...step.values };

  assert.equal(rowAfterUndo.calories_estimate, 300, "the calorie correction is reversed");
  assert.equal(rowAfterUndo.description, "6 boiled eggs and curd", "the 15:00 description edit SURVIVES the undo");
  assert.equal(rowAfterUndo.protein_g, 47, "and so does the 15:00 protein edit");
  assert.deepEqual(Object.keys(step.values), ["calories_estimate"], "exactly one column was written");
}

// ---- already-undone is a no-op, not an error --------------------------------
{
  assert.equal(isAlreadyUndone({ status: "reverted" }), true);
  assert.equal(isAlreadyUndone({ status: "rejected" }), true);
  assert.equal(isAlreadyUndone({ status: "auto_applied", undo_payload: { v: 2, op: "insert", table: "notes", id: "n1", undone_at: "2026-08-06T10:00:00Z" } }), true);
  assert.equal(isAlreadyUndone({ status: "auto_applied", undo_payload: { v: 2, op: "insert", table: "notes", id: "n1" } }), false);

  const plan = undoPlan([
    { id: "a1", status: "reverted", created_at: "2026-08-06T09:00:00Z", undo_payload: { table: "food_logs", id: "f1" } },
  ]);
  assert.equal(plan.steps.length, 0);
  assert.deepEqual(plan.alreadyUndone, [{ actionId: "a1", reason: "already_undone" }]);
  assert.deepEqual(plan.skipped, []);
}

// ---- undoPlan ordering -----------------------------------------------------
// Reverse-chronological, then DELETES before INSERTS/restores.
{
  const actions = [
    { id: "a1", status: "auto_applied", created_at: "2026-08-06T09:00:00Z", undo_payload: { table: "food_logs", id: "f1" } },
    { id: "a2", status: "auto_applied", created_at: "2026-08-06T10:00:00Z", undo_payload: { table: "ledger_entries", id: "l1" } },
    { id: "a3", status: "auto_applied", created_at: "2026-08-06T11:00:00Z", undo_payload: { v: 2, op: "delete", table: "notes", id: "n1" } },
    { id: "a4", status: "auto_applied", created_at: "2026-08-06T12:00:00Z", undo_payload: { table: "workout_logs", id: "w1" } },
    { id: "a5", status: "errored", created_at: "2026-08-06T13:00:00Z", undo_payload: { error: "boom" } },
  ];
  const { steps, skipped, alreadyUndone } = undoPlan(actions);
  assert.deepEqual(steps.map((s) => s.actionId), ["a4", "a2", "a1", "a3"],
    "the three tombstones run newest-first, then the restore");
  assert.deepEqual(steps.map((s) => s.op), ["soft_delete", "soft_delete", "soft_delete", "restore"]);
  assert.deepEqual(skipped, [{ actionId: "a5", reason: "no_undo_record" }]);
  assert.deepEqual(alreadyUndone, []);
  // Every step names the row it will touch - nothing is left to be re-derived.
  for (const s of steps) assert.ok(s.table && s.id, `step ${s.actionId} names its target`);
}

// ---- describeUndo ----------------------------------------------------------
assert.equal(describeUndo({ table: "food_logs", id: "f1" }), "Remove the food log it added.");
assert.equal(describeUndo({ v: 2, op: "delete", table: "notes", id: "n1" }), "Put the deleted note back.");
assert.match(
  describeUndo({ v: 2, op: "upsert", table: "budgets", id: "b1", before: { amount: 150 }, columns: ["amount"] }),
  /^Put amount on the target back/,
);
assert.equal(describeUndo({ errors: ["x"] }), "Nothing to undo.");

// ---- the soft-delete surface -----------------------------------------------
{
  // Exactly the eleven tables the model can reach.
  assert.deepEqual([...SOFT_DELETABLE_TABLES].sort(), [
    "body_metrics", "food_logs", "hydration_logs", "ledger_entries", "memory_facts",
    "notes", "reminders", "sleep_sessions", "user_plans", "wellness_logs", "workout_logs",
  ]);
  assert.equal(PURGE_AFTER_DAYS, 30);
  // Every table an insert-undo tombstones must actually be soft-deletable.
  for (const table of SOFT_DELETABLE_TABLES) {
    assert.equal(invert(undoPayloadFor({ op: "insert", table, id: "x" })).op, "soft_delete");
  }
}

// ---------------------------------------------------------------------------
// THE AMENDMENT ROUND TRIP.
//
// The interleaving proof above is written by hand. This one runs the SAME shape
// through the real producer - lib/amend-target.mjs, the module that builds the
// plan the server stores and the client executes - so the payload under test is
// the payload production writes, not a hand-shaped facsimile of it.
//
// The owner's case: a 30 g aloo bhujia snack corrected to 50 g at 15:14, an
// unrelated edit at 15:30, and the undo at 16:00.
// ---------------------------------------------------------------------------
{
  const { amendWritePlan } = await import("../lib/amend-target.mjs");

  const rowBefore = {
    id: "f-bhujia", table: "food_logs",
    description: "30g aloo bhujia and 2 soup sachets", meal_slot: "snack",
    calories_estimate: 205, protein_g: 4,
  };

  // 15:14 - the correction.
  const plan = amendWritePlan({
    name: "amend_log_candidate",
    args: { target_kind: "food", set: { description: "50g aloo bhujia and 2 soup sachets", calories_estimate: 365, protein_g: 8 } },
    row: rowBefore,
  });
  assert.equal(plan.op, "update");
  const payload = undoPayloadFor({
    op: "update", table: plan.table, id: plan.id,
    before: plan.before, after: plan.values, columns: plan.columns,
  });
  assert.equal(isUndoable(payload), true);
  assert.deepEqual([...undoColumns(payload)].sort(), ["calories_estimate", "description", "protein_g"]);

  // 15:30 - a later, legitimate edit moves the snack to a different slot and
  // fixes a typo the amendment did not touch.
  const rowAfterAmend = { ...rowBefore, ...plan.values };
  const rowAt1530 = { ...rowAfterAmend, meal_slot: "dinner", meal_name: "Evening snack" };

  // 16:00 - undo the amendment only.
  const step = invert(payload);
  const restored = { ...rowAt1530, ...step.values };
  assert.equal(restored.description, "30g aloo bhujia and 2 soup sachets", "the correction is reversed");
  assert.equal(restored.calories_estimate, 205);
  assert.equal(restored.protein_g, 4);
  assert.equal(restored.meal_slot, "dinner", "the 15:30 slot change SURVIVES the undo");
  assert.equal(restored.meal_name, "Evening snack", "and so does the 15:30 name");
  assert.equal(Object.keys(step.values).length, 3, "exactly the three columns the amendment wrote");

  // And the undo of a DELETE is a restore, never a re-insert of a phantom.
  const delPlan = amendWritePlan({ name: "delete_log_candidate", args: { target_kind: "food" }, row: rowBefore });
  const delPayload = undoPayloadFor({ op: "delete", table: delPlan.table, id: delPlan.id, before: delPlan.before });
  assert.equal(isUndoable(delPayload), true);
  assert.equal(invert(delPayload).op, "restore");
  assert.deepEqual(invert(delPayload).values, { deleted_at: null });
  assert.equal(describeUndo(delPayload), "Put the deleted food log back.");
  assert.match(describeUndo(payload), /^Put .* on the food log back/);

  // An amendment plan with no before-image is NOT undoable, and says why. An
  // edit that cannot be put back must never be offered as reversible.
  assert.equal(isUndoable(undoPayloadFor({ op: "update", table: "food_logs", id: "f1", after: { protein_g: 8 }, columns: ["protein_g"] })), false);
  assert.equal(undoBlockReason(undoPayloadFor({ op: "update", table: "food_logs", id: "f1", after: { protein_g: 8 }, columns: ["protein_g"] })), "no_before_image");

  // Every table an amendment can reach is soft-deletable, so a delete there is
  // always a tombstone that a restore can clear.
  const { AMEND_TABLE_FOR_KIND } = await import("../lib/amend-target.mjs");
  for (const table of Object.values(AMEND_TABLE_FOR_KIND)) {
    assert.ok(SOFT_DELETABLE_TABLES.includes(table), `${table} is amendable but not soft-deletable`);
  }
}

console.log("undo-ledger tests passed");
