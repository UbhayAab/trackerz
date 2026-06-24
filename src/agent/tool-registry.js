export const toolRegistry = [
  { name: "create_expense_candidate", domain: "money", write: true, destructive: false },
  { name: "create_income_candidate", domain: "money", write: true, destructive: false },
  { name: "create_transfer_candidate", domain: "money", write: true, destructive: false },
  { name: "create_statement_row_candidate", domain: "money", write: true, destructive: false },
  { name: "create_food_log_candidate", domain: "diet", write: true, destructive: false },
  { name: "estimate_food_macros", domain: "diet", write: false, destructive: false },
  { name: "create_workout_log_candidate", domain: "fitness", write: true, destructive: false },
  { name: "create_body_metric_candidate", domain: "fitness", write: true, destructive: false },
  { name: "create_wellness_note_candidate", domain: "wellness", write: true, destructive: false },
  { name: "link_duplicate_candidates", domain: "all", write: true, destructive: false },
  { name: "update_plan_candidate", domain: "all", write: true, destructive: false },
  { name: "request_user_review", domain: "all", write: false, destructive: false },
  { name: "apply_verified_action", domain: "all", write: true, destructive: false },
  { name: "undo_ai_action", domain: "all", write: true, destructive: false },
];

export function getTool(name) {
  return toolRegistry.find((tool) => tool.name === name) ?? null;
}

export function isKnownTool(name) {
  return Boolean(getTool(name));
}
