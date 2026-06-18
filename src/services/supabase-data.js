import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import { buildRowForTool } from "./action-applier.js";
import { instantiate } from "../domain/diet/meal-templates.js";

function requireUserId() {
  const session = getCurrentSession();
  if (!session?.user?.id) throw new Error("not_authenticated");
  return session.user.id;
}

export async function insertRawIngestion({ sourceType, captureMode = "auto", rawText = null, occurredAt = null }) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("raw_ingestions")
    .insert({
      user_id: userId,
      source_type: sourceType,
      capture_mode: captureMode,
      raw_text: rawText,
      occurred_at: occurredAt,
      status: "queued",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function uploadMediaFile(file, { kind, ingestionId }) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const bucket = kind === "statement" ? "statements" : "raw-media";
  const path = `${userId}/${ingestionId}/${Date.now()}-${safeName(file.name || "file")}`;
  const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || "application/octet-stream",
  });
  if (upErr) throw upErr;

  const { data, error } = await supabase
    .from("media_assets")
    .insert({
      user_id: userId,
      ingestion_id: ingestionId,
      storage_bucket: bucket,
      storage_path: path,
      mime_type: file.type || "application/octet-stream",
      original_name: file.name || null,
      byte_size: file.size || null,
      media_kind: kindForMime(file.type, kind),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function kindForMime(mime, fallback) {
  if (!mime) return fallback === "statement" ? "statement" : fallback || "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.includes("excel") || mime.includes("spreadsheet") || mime === "text/csv") return "statement";
  return "document";
}

export async function fetchLedger({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("ledger_entries")
    .select("id, occurred_at, merchant, description, amount, currency, direction, payment_mode, duplicate_state, confidence, is_discretionary, tags")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function fetchFoodLogs({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("food_logs")
    .select("id, occurred_at, meal_name, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g, confidence, duplicate_state")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function fetchBodyMetrics({ limit = 400 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("body_metrics")
    .select("id, metric_type, value, unit, occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function fetchWellnessLogs({ limit = 200 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("wellness_logs")
    .select("id, note, mood_score, energy_score, stress_score, occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function fetchSubscriptions() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, merchant, cadence_days, median_amount, sample_count, next_expected_at, is_active")
    .eq("is_active", true)
    .order("next_expected_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Upserts detected subscriptions (unique per user+merchant). Returns the rows.
export async function persistDetectedSubscriptions(subs = []) {
  if (!subs.length) return [];
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const rows = subs.map((s) => ({
    user_id: userId,
    merchant: s.merchant,
    cadence_days: s.cadence_days,
    median_amount: s.median_amount,
    sample_count: s.sample_count,
    next_expected_at: s.next_expected_at,
    first_seen_at: s.first_seen_at,
    last_seen_at: s.last_seen_at,
    is_active: true,
  }));
  const { data, error } = await supabase
    .from("subscriptions")
    .upsert(rows, { onConflict: "user_id,merchant" })
    .select();
  if (error) throw error;
  return data || [];
}

// ---- one-tap quick logs (bypass Gemini; direct user-client writes) ----

export async function logHydration(ml) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("hydration_logs")
    .insert({ user_id: userId, ml: Math.round(Number(ml) || 0), occurred_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function logQuickWellness({ mood_score = null, energy_score = null, stress_score = null, note = "" } = {}) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("wellness_logs")
    .insert({
      user_id: userId,
      note: note || "quick log",
      mood_score, energy_score, stress_score,
      occurred_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function fetchMealTemplates({ limit = 8 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("meal_templates")
    .select("id, name, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g, use_count, last_used_at")
    .order("use_count", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function logMealFromTemplate(template) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  // instantiate() carries a source_template_id helper field that is not a
  // food_logs column — strip it before insert.
  const { source_template_id, ...foodRow } = instantiate(template);
  const { data, error } = await supabase
    .from("food_logs")
    .insert({ user_id: userId, ...foodRow })
    .select()
    .single();
  if (error) throw error;
  // Best-effort usage bump so quick chips order by recency/frequency.
  if (template.id) {
    await supabase
      .from("meal_templates")
      .update({ use_count: (template.use_count || 0) + 1, last_used_at: new Date().toISOString() })
      .eq("id", template.id)
      .then(() => {}, () => {});
  }
  return data;
}

export async function fetchOpenAiActions({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("ai_actions")
    .select("id, tool_name, arguments, confidence, status, created_at")
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function fetchOpenImports({ limit = 20 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("statement_imports")
    .select("id, source_name, detected_bank, status, row_count, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function fetchBudgets() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("budgets")
    .select("id, period, amount, starts_on, category_id")
    .order("starts_on", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function upsertBudget({ period, amount, startsOn, categoryId = null }) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("budgets")
    .insert({ user_id: userId, period, amount, starts_on: startsOn, category_id: categoryId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function fetchDuplicates({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("duplicate_candidates")
    .select("id, domain, record_a_table, record_a_id, record_b_table, record_b_id, score, reason, status, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function applyAiAction(actionId) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from("ai_actions")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("id", actionId);
  if (error) throw error;
}

// Approve a proposed action: actually write the domain row (RLS-safe, user
// client) the way the server auto-apply path would, THEN mark the action
// applied with provenance. This is what makes the review queue persist.
export async function applyProposedAction(action) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const built = buildRowForTool(action, userId);
  let appliedTable = null;
  let appliedId = null;
  if (built) {
    const { data, error } = await supabase.from(built.table).insert(built.row).select().single();
    if (error) throw error;
    appliedTable = built.table;
    appliedId = data.id;
  }
  const { error: upErr } = await supabase
    .from("ai_actions")
    .update({
      status: "applied",
      applied_at: new Date().toISOString(),
      applied_record_table: appliedTable,
      applied_record_id: appliedId,
    })
    .eq("id", action.id);
  if (upErr) throw upErr;
  return { id: action.id, appliedTable, appliedId };
}

// Bulk-approve. Continues past individual failures and reports per-action.
export async function applyProposedActions(actions = []) {
  const results = [];
  for (const action of actions) {
    try {
      results.push(await applyProposedAction(action));
    } catch (err) {
      results.push({ id: action.id, error: err?.message || String(err) });
    }
  }
  return results;
}

export async function rejectAiAction(actionId) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from("ai_actions")
    .update({ status: "rejected" })
    .eq("id", actionId);
  if (error) throw error;
}

// Server-side data erasure: wipe every row this user owns and their stored
// media. The profile row is kept so the account still works. RLS guarantees
// only the caller's own rows are touched.
const USER_DATA_TABLES = [
  "ai_actions", "ai_runs", "ledger_entries", "food_logs", "body_metrics",
  "wellness_logs", "workout_logs", "statement_rows", "statement_imports",
  "duplicate_candidates", "budgets", "categories", "subscriptions",
  "merchant_aliases", "category_memory", "bank_format_memory", "meal_templates",
  "hydration_logs", "weekly_reviews", "media_assets", "raw_ingestions",
];

export async function deleteAllUserData() {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const errors = [];
  for (const table of USER_DATA_TABLES) {
    const { error } = await supabase.from(table).delete().eq("user_id", userId);
    if (error) errors.push(`${table}: ${error.message}`);
  }
  // Best-effort storage cleanup (paths are `${userId}/${ingestionId}/file`).
  for (const bucket of ["raw-media", "statements"]) {
    try {
      const { data: folders } = await supabase.storage.from(bucket).list(userId);
      for (const folder of folders || []) {
        const prefix = `${userId}/${folder.name}`;
        const { data: files } = await supabase.storage.from(bucket).list(prefix);
        const paths = (files || []).map((f) => `${prefix}/${f.name}`);
        if (paths.length) await supabase.storage.from(bucket).remove(paths);
      }
    } catch {
      // storage cleanup is best-effort; row deletion is the source of truth
    }
  }
  return { errors };
}
