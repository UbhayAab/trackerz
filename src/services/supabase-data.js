import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";

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

export async function rejectAiAction(actionId) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from("ai_actions")
    .update({ status: "rejected" })
    .eq("id", actionId);
  if (error) throw error;
}
