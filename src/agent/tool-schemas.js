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
  answer_question: {
    required: ["answer"],
    types: { answer: "string", question: "string", basis: "string" },
  },
  update_plan_candidate: {
    required: ["kind"],
    types: { kind: "string", scope: "string", summary: "string", payload: "object" },
    enums: { kind: ["diet", "gym"] },
  },
  create_reminder_candidate: {
    required: ["title", "freq"],
    types: {
      title: "string", note: "string", kind: "string", freq: "string",
      day_of_month: "number", month_of_year: "number", weekday: "number",
      on_date: "string", lead_days: "number",
    },
    enums: {
      freq: ["once", "daily", "weekly", "monthly", "quarterly", "yearly"],
      kind: ["task", "birthday", "anniversary", "bill", "filing", "appointment", "other", null],
    },
    ranges: { day_of_month: [1, 31], month_of_year: [1, 12], weekday: [0, 6], lead_days: [0, 60] },
  },
  create_note_candidate: {
    required: ["body"],
    types: { body: "string", kind: "string", domain: "string", status: "string", due_on: "string", occurred_at: "iso" },
    enums: {
      kind: ["note", "aspiration", "todo", "idea", null],
      domain: ["money", "diet", "gym", "wellness", "general", null],
      status: ["open", "done", "archived", null],
    },
  },
  set_target_candidate: {
    required: ["kind", "amount"],
    types: { kind: "string", amount: "positive_number", reason: "string" },
    enums: { kind: ["monthly_spend", "weekly_spend", "food_cap", "daily_calories", "daily_protein", "weekly_calories", "weekly_workouts"] },
  },
  remember_fact: {
    required: ["key", "value"],
    types: { key: "string", value: "string", kind: "string", confidence: "number" },
    enums: { kind: ["preference", "pattern", "fact", "goal", null] },
    ranges: { confidence: [0, 1] },
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

// A required field the model supplied under a NEAR-MISS NAME is not a missing
// field, but validateToolArguments cannot tell the difference: it sees
// `required:description` and the whole tool call is thrown away as `rejected`.
// What makes that worse than losing the call is what happens next - the
// deterministic salvage in fan-out-expander.mjs then synthesizes a replacement
// from the raw capture text, and THAT one applies. So the detailed row loses to
// the crude one. Measured on 2026-08-03: the model emitted a cardio log with
// duration 21.43 min, 2.3 km and 216 kcal under `name`/`notes`; it was rejected
// for `required:description`, and the row that landed was the raw OCR blob with
// no duration, no distance and no calories. Same shape on 2026-07-30 (gym) and
// 2026-07-29 (food, `required:occurred_at`).
//
// So: before validating, fill a missing required field from an obvious alias, and
// let a missing occurred_at mean "now" - which is what an untimed capture means
// and exactly what the salvage path already assumes. Never overwrite a value the
// model did supply.
const REQUIRED_ALIASES = {
  description: ["name", "title", "label", "activity", "item", "meal_name", "summary", "notes", "body", "text"],
  occurred_at: ["timestamp", "datetime", "date", "logged_at", "started_at", "at", "when"],
  amount: ["value", "total", "price", "cost"],
  note: ["body", "text", "description", "summary"],
  body: ["note", "text", "description", "summary"],
  answer: ["text", "response", "reply"],
  reason: ["summary", "text"],
  value: ["amount", "text"],
};

function firstFilled(args, keys) {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function repairToolArguments(name, args, nowIso) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) return args;
  for (const key of schema.required || []) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== "") continue;
    const alias = firstFilled(args, REQUIRED_ALIASES[key] || []);
    if (alias !== undefined) {
      args[key] = alias;
      // "Cardio machine session" alone throws away the readout that was sitting
      // in `notes`. Keep both when the description came from a bare label.
      if (key === "description" && typeof args.name === "string" && args.name.trim() === alias
        && typeof args.notes === "string" && args.notes.trim()) {
        args[key] = `${alias} - ${args.notes.trim()}`;
      }
      continue;
    }
    // Last resort, only for time: an untimed capture happened now.
    if (key === "occurred_at") args[key] = nowIso || new Date().toISOString();
  }
  return args;
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
