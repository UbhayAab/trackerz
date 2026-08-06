// The client-side allowlist of tool names the AI may emit. It is one of THREE
// lists that must agree, and tests/tool-sync.test.mjs now fails the build when
// they drift:
//   1. this registry              - the client's idea of what exists
//   2. ALLOWED_TOOLS              - what the edge function will accept
//   3. applyTool()'s switch cases - what the edge function can actually do
//
// On the day that test was written it failed immediately: `estimate_food_macros`,
// `apply_verified_action` and `undo_ai_action` were listed here with ZERO
// occurrences anywhere in supabase/functions/agent/index.ts. They had no entry in
// ALLOWED_TOOLS, no schema, no applyTool case and no prompt text - the edge
// function would have rejected all three as `unknown_tool`. They were pure
// decoration: three capabilities the registry advertised and the app has never
// had, in exactly the "computed and never surfaced" shape this codebase keeps
// producing. They are removed rather than implemented, because deleting a tool
// name that does nothing is strictly safer than shipping a half-built
// apply/undo path for AI-written rows. Re-adding any of them means adding it to
// ALLOWED_TOOLS + TOOL_SCHEMAS + applyTool() + SYSTEM_PROMPT in the same change,
// which is precisely what the test enforces.
export const toolRegistry = [
  { name: "create_expense_candidate", domain: "money", write: true, destructive: false },
  { name: "create_income_candidate", domain: "money", write: true, destructive: false },
  { name: "create_transfer_candidate", domain: "money", write: true, destructive: false },
  { name: "create_statement_row_candidate", domain: "money", write: true, destructive: false },
  { name: "create_food_log_candidate", domain: "diet", write: true, destructive: false },
  { name: "create_workout_log_candidate", domain: "fitness", write: true, destructive: false },
  { name: "create_body_metric_candidate", domain: "fitness", write: true, destructive: false },
  { name: "create_wellness_note_candidate", domain: "wellness", write: true, destructive: false },
  { name: "create_hydration_candidate", domain: "wellness", write: true, destructive: false },
  { name: "create_sleep_candidate", domain: "wellness", write: true, destructive: false },
  { name: "create_note_candidate", domain: "all", write: true, destructive: false },
  { name: "create_reminder_candidate", domain: "all", write: true, destructive: false },
  { name: "set_target_candidate", domain: "all", write: true, destructive: false },
  { name: "remember_fact", domain: "all", write: true, destructive: false },
  // write:false, not true. The edge function keeps this OUT of WRITE_TOOLS and
  // out of applyTool() on purpose - it never writes a domain row, it flags two
  // candidates as the same event for review. The registry claimed it was a
  // writer, which is the third drift tests/tool-sync.test.mjs caught on day one.
  { name: "link_duplicate_candidates", domain: "all", write: false, destructive: false },
  { name: "update_plan_candidate", domain: "all", write: true, destructive: false },
  { name: "request_user_review", domain: "all", write: false, destructive: false },
  // Writes nothing - it carries the AI's reply to a question back to the UI.
  { name: "answer_question", domain: "all", write: false, destructive: false },
];

export function getTool(name) {
  return toolRegistry.find((tool) => tool.name === name) ?? null;
}

export function isKnownTool(name) {
  return Boolean(getTool(name));
}
