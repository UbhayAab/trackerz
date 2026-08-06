// Pure mapping from a proposed AI action (tool_name + arguments) to the table +
// row to insert when a user approves it. This MIRRORS applyTool() in
// supabase/functions/agent/index.ts so a manually-approved proposed action
// creates exactly the same row the server auto-apply path would have.
// tests/agent-contract.test.mjs asserts this list stays in sync with the edge
// function's WRITE_TOOLS. No browser/Supabase imports - keep it pure.

import { goalDef } from "../domain/goals.js";
import { sleepWindowFromArgs } from "../../lib/sleep-window.mjs";
import { reminderColumns, taskRow, saDayKey, saMinuteOfDay, SA_DEFAULT_TZ } from "../../lib/schedule-args.mjs";

export const APPLIER_WRITE_TOOLS = [
  "create_reminder_candidate",
  "schedule_task_candidate",
  "create_expense_candidate",
  "create_income_candidate",
  "create_transfer_candidate",
  "create_statement_row_candidate",
  "create_food_log_candidate",
  "create_workout_log_candidate",
  "create_body_metric_candidate",
  "create_wellness_note_candidate",
  "create_hydration_candidate",
  "create_sleep_candidate",
  "create_note_candidate",
  "set_target_candidate",
  "remember_fact",
  "update_plan_candidate",
  "amend_log_candidate",
  "delete_log_candidate",
];

export function buildRowForTool(action, userId) {
  const args = action?.arguments || {};
  const ingestionId = action?.ingestion_id || null;
  const confidence = typeof action?.confidence === "number" ? action.confidence : 1;
  const occurredAt = args.occurred_at || new Date().toISOString();
  const base = { user_id: userId, ingestion_id: ingestionId };

  switch (action?.tool_name) {
    case "create_expense_candidate":
      return { table: "ledger_entries", row: {
        ...base, amount: args.amount, currency: args.currency || "INR", direction: "expense",
        merchant: args.merchant || null, description: args.description || null,
        payment_mode: args.payment_mode || null, occurred_at: occurredAt, confidence,
        is_discretionary: Boolean(args.is_discretionary),
        tags: Array.isArray(args.tags) ? args.tags : [],
      } };
    case "create_income_candidate":
      return { table: "ledger_entries", row: {
        ...base, amount: args.amount, currency: args.currency || "INR", direction: "income",
        merchant: args.source || null, description: args.description || null, occurred_at: occurredAt, confidence,
      } };
    case "create_transfer_candidate":
      return { table: "ledger_entries", row: {
        ...base, amount: args.amount, currency: args.currency || "INR", direction: "transfer",
        description: args.description || null, occurred_at: occurredAt, confidence,
      } };
    case "create_statement_row_candidate": {
      const dir = ["expense", "income", "transfer"].includes(args.direction) ? args.direction : "expense";
      return { table: "ledger_entries", row: {
        ...base, amount: Math.abs(Number(args.amount)) || 0, currency: args.currency || "INR", direction: dir,
        merchant: args.merchant || null, description: args.description || null, occurred_at: occurredAt, confidence,
        tags: args.reference ? [String(args.reference)] : [],
      } };
    }
    case "create_food_log_candidate":
      return { table: "food_logs", row: {
        ...base, meal_name: args.meal_name || null, meal_slot: args.meal_slot || "other",
        description: args.description || "", calories_estimate: args.calories_estimate ?? null,
        protein_g: args.protein_g ?? null, carbs_g: args.carbs_g ?? null, fat_g: args.fat_g ?? null,
        confidence, occurred_at: occurredAt,
      } };
    case "create_workout_log_candidate":
      return { table: "workout_logs", row: {
        ...base, description: args.description || "", duration_min: args.duration_min ?? null,
        intensity: args.intensity || null, occurred_at: occurredAt,
        // A 'skipped' row records that the day was answered without counting as
        // training. Dropping this field here (it used to be dropped) is what let
        // "Did not go to gym bro" land as a completed workout.
        status: args.status === "skipped" || args.status === "rest" ? args.status : "done",
      } };
    case "create_hydration_candidate":
      return { table: "hydration_logs", row: {
        user_id: userId, ml: Math.round(Number(args.ml)) || 0, occurred_at: occurredAt,
      } };
    case "create_sleep_candidate": {
      // Same window resolution the edge function uses: a duration ("slept 7h"),
      // an explicit window, or an open bedtime marker - see lib/sleep-window.mjs.
      const sleep = sleepWindowFromArgs(args, occurredAt);
      return { table: "sleep_sessions", row: {
        ...base, started_at: sleep.started_at, ended_at: sleep.ended_at,
        quality: args.quality ?? null, note: sleep.note, source: "capture",
      } };
    }
    case "create_body_metric_candidate":
      return { table: "body_metrics", row: {
        ...base, metric_type: args.metric_type, value: args.value, unit: args.unit || "", occurred_at: occurredAt,
      } };
    case "create_wellness_note_candidate":
      return { table: "wellness_logs", row: {
        ...base, note: args.note || "", mood_score: args.mood_score ?? null,
        energy_score: args.energy_score ?? null, stress_score: args.stress_score ?? null, occurred_at: occurredAt,
      } };
    case "update_plan_candidate":
      return { table: "user_plans", row: {
        user_id: userId,
        kind: args.kind || "diet",
        scope: args.scope || "permanent",
        summary: args.summary || args.description || null,
        payload: (args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)) ? args.payload : {},
        source: "ai",
      } };
    case "create_note_candidate":
      return { table: "notes", row: {
        ...base, kind: args.kind || "note", body: args.body || "",
        domain: args.domain || "general", status: args.status || "open",
        due_on: args.due_on || null, occurred_at: occurredAt,
      } };
    case "create_reminder_candidate":
      // A recurring calendar fact. No occurred_at: a reminder is not something
      // that happened, it is a rule about dates that have not arrived yet.
      //
      // Both this and the edge function call reminderColumns(), rather than each
      // keeping its own column list. The old hand-written copy here already
      // silently dropped at_time, interval, weekdays, nth_weekday, until and
      // count - so approving a proposed reminder by hand produced a DIFFERENT,
      // weaker rule than letting it auto-apply, which is the one thing the
      // header comment of this file promises cannot happen.
      return { table: "reminders", row: {
        ...base,
        ...reminderColumns(args, { today: saDayKey(occurredAt, SA_DEFAULT_TZ), tz: SA_DEFAULT_TZ }),
      } };
    case "schedule_task_candidate":
      // The app scheduling itself. Same shared builder for the same reason.
      return { table: "agent_tasks", row: {
        user_id: userId,
        ...taskRow(args, {
          today: saDayKey(occurredAt, SA_DEFAULT_TZ),
          nowMinutes: saMinuteOfDay(occurredAt, SA_DEFAULT_TZ),
          tz: SA_DEFAULT_TZ,
        }),
        created_by: "agent",
        origin_ingestion_id: ingestionId,
        depth: 1,
        dedupe_key: ingestionId ? `cap:${ingestionId}` : null,
      } };
    case "set_target_candidate":
      // Upsert the single canonical budget row for this goal kind (see goals.js).
      return { table: "budgets", conflictTarget: "user_id,kind", row: {
        user_id: userId,
        kind: args.kind,
        period: goalDef(args.kind)?.period || "monthly",
        amount: args.amount,
        starts_on: occurredAt.slice(0, 10),
      } };
    case "remember_fact":
      // Upsert durable long-term memory by key.
      return { table: "memory_facts", conflictTarget: "user_id,key", row: {
        user_id: userId,
        key: args.key,
        value: args.value != null ? String(args.value) : "",
        kind: args.kind || "fact",
        confidence: typeof args.confidence === "number" ? args.confidence : 0.7,
        source: "ai",
        // Where the fact came from, stamped on the tool call by
        // enforceCapabilities (lib/provenance.mjs) when the agent ran. A fact
        // the user taps "Add it" on must land with the SAME provenance it was
        // proposed with - otherwise a screenshot-derived fact is laundered into
        // an unattributed one by the act of confirming it. "unknown" rather than
        // "typed" when the stamp is missing: fail closed.
        provenance: args._provenance || "unknown",
        updated_at: new Date().toISOString(),
      } };
    // ---- the two tools that change a row that already exists ----------------
    //
    // These do NOT build a row from the arguments. The arguments name a phrase
    // and a date; the ROW they refer to was resolved on the server, against the
    // closed set of rows inside that date window, and the resulting plan was
    // stamped onto the action as `_amend` before the user ever saw it. This
    // function reads that plan and nothing else.
    //
    // That is the whole point. If the client re-resolved "the 30 g aloo bhujia"
    // at confirm time it could land on a different row than the diff card the
    // user was looking at when they tapped - a preview and a write that disagree,
    // which is exactly what ingestStatements() exists to prevent for imports.
    // A missing or unresolved plan returns null, and applyProposedAction refuses
    // to mark the action applied, rather than reporting a write that never
    // happened.
    case "amend_log_candidate": {
      const plan = args._amend;
      if (!plan || plan.op !== "update" || !plan.table || !plan.id || !plan.columns?.length) return null;
      return {
        table: plan.table, id: plan.id, op: "update",
        row: plan.values, columns: plan.columns, before: plan.before || null,
      };
    }
    case "delete_log_candidate": {
      const del = args._amend;
      if (!del || del.op !== "soft_delete" || !del.table || !del.id) return null;
      // A tombstone, never a removal: `deleted_at` is stamped at APPLY time, not
      // when the plan was made, because the 30-day purge clock starts from the
      // moment the user actually said yes.
      return {
        table: del.table, id: del.id, op: "soft_delete",
        row: { deleted_at: new Date().toISOString() }, columns: ["deleted_at"], before: del.before || null,
      };
    }
    default:
      return null; // non-write tools (request_user_review, link_duplicate_candidates)
  }
}

export default buildRowForTool;
