// Pure mapping from a proposed AI action (tool_name + arguments) to the table +
// row to insert when a user approves it. This MIRRORS applyTool() in
// supabase/functions/agent/index.ts so a manually-approved proposed action
// creates exactly the same row the server auto-apply path would have.
// tests/agent-contract.test.mjs asserts this list stays in sync with the edge
// function's WRITE_TOOLS. No browser/Supabase imports - keep it pure.

import { goalDef } from "../domain/goals.js";
import { sleepWindowFromArgs } from "../../lib/sleep-window.mjs";

export const APPLIER_WRITE_TOOLS = [
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
        updated_at: new Date().toISOString(),
      } };
    default:
      return null; // non-write tools (request_user_review, link_duplicate_candidates)
  }
}

export default buildRowForTool;
