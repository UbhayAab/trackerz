// Tool-argument schemas + validator. Pure functions, no deps.
// Mirrors the spec in supabase/functions/agent/index.ts so the browser and
// the edge function agree on what a valid tool call looks like.
//
// Each schema entry: { required: [keys], types: { key: type | [types] }, enums: {...} }
// type can be "string" | "number" | "boolean" | "iso" | "array" | "object".

export const TOOL_SCHEMAS = {
  create_expense_candidate: {
    required: ["amount", "occurred_at"],
    types: {
      amount: "positive_number",
      currency: "string",
      merchant: "string",
      description: "string",
      payment_mode: "string",
      occurred_at: "iso",
      is_discretionary: "boolean",
      tags: "array",
    },
    enums: {
      payment_mode: ["upi", "card", "cash", "netbanking", "wallet", "transfer", "other", null],
    },
  },
  create_income_candidate: {
    required: ["amount", "occurred_at"],
    types: { amount: "positive_number", currency: "string", source: "string", description: "string", occurred_at: "iso" },
  },
  create_transfer_candidate: {
    required: ["amount", "occurred_at"],
    types: { amount: "positive_number", description: "string", occurred_at: "iso", from_account: "string", to_account: "string" },
  },
  create_statement_row_candidate: {
    required: ["amount", "occurred_at"],
    types: {
      amount: "number", direction: "string", merchant: "string", description: "string", occurred_at: "iso", reference: "string",
    },
    enums: { direction: ["expense", "income", "transfer"] },
  },
  create_food_log_candidate: {
    required: ["description", "occurred_at"],
    types: {
      meal_slot: "string", meal_name: "string", description: "string",
      calories_estimate: "number", protein_g: "number", carbs_g: "number", fat_g: "number",
      occurred_at: "iso",
    },
    enums: { meal_slot: ["breakfast", "lunch", "snack", "dinner", "other", null] },
  },
  create_workout_log_candidate: {
    required: ["description", "occurred_at"],
    types: { description: "string", duration_min: "number", intensity: "string", occurred_at: "iso" },
  },
  create_body_metric_candidate: {
    required: ["metric_type", "value", "occurred_at"],
    types: { metric_type: "string", value: "number", unit: "string", occurred_at: "iso" },
    enums: { metric_type: ["weight", "sleep_hours", "steps", "water_ml"] },
  },
  create_wellness_note_candidate: {
    required: ["note", "occurred_at"],
    types: {
      note: "string", mood_score: "number", energy_score: "number", stress_score: "number", occurred_at: "iso",
    },
    ranges: {
      mood_score: [1, 10], energy_score: [1, 10], stress_score: [1, 10],
    },
  },
  link_duplicate_candidates: {
    required: ["candidate_a", "candidate_b"],
    types: { candidate_a: "string", candidate_b: "string", reason: "string" },
  },
  request_user_review: {
    required: ["reason"],
    types: { reason: "string", raw_input: "string" },
  },
  update_plan_candidate: {
    required: ["kind"],
    types: { kind: "string", scope: "string", summary: "string", payload: "object" },
    enums: { kind: ["diet", "gym"] },
  },
};

function isIso(v) {
  if (typeof v !== "string") return false;
  return !Number.isNaN(Date.parse(v));
}

function typeOk(value, expected) {
  if (value === null || value === undefined) return true; // optional fields allowed
  switch (expected) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "positive_number": return typeof value === "number" && Number.isFinite(value) && value > 0;
    case "boolean": return typeof value === "boolean";
    case "iso": return isIso(value);
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && !Array.isArray(value);
    default: return false;
  }
}

export function validateToolArguments(name, args) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return { ok: false, errors: ["unknown_tool"] };
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, errors: ["arguments_not_object"] };

  const errors = [];
  for (const key of schema.required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") errors.push(`required:${key}`);
  }
  for (const [key, expected] of Object.entries(schema.types || {})) {
    if (args[key] !== undefined && !typeOk(args[key], expected)) errors.push(`type:${key}:${expected}`);
  }
  for (const [key, allowed] of Object.entries(schema.enums || {})) {
    if (args[key] !== undefined && !allowed.includes(args[key])) errors.push(`enum:${key}:${args[key]}`);
  }
  for (const [key, [lo, hi]] of Object.entries(schema.ranges || {})) {
    if (typeof args[key] === "number" && (args[key] < lo || args[key] > hi)) errors.push(`range:${key}:${lo}-${hi}`);
  }
  return { ok: errors.length === 0, errors };
}

export function sanitizeArguments(name, args) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return args;
  const out = {};
  const keys = new Set([...(schema.required || []), ...Object.keys(schema.types || {})]);
  for (const key of keys) {
    if (args && args[key] !== undefined) out[key] = args[key];
  }
  return out;
}
