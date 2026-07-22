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
    .select("id, occurred_at, merchant, description, amount, currency, direction, payment_mode, duplicate_state, confidence, is_discretionary, tags, merged_into")
    // A merged-away duplicate must not be counted again. This function feeds
    // EVERY browser-side money number (the month tile, the period aggregator,
    // opportunity cost, exports), so without this filter merging a duplicate
    // would visibly change nothing - the whole point of the merge.
    .is("merged_into", null)
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

// Total ml drunk on the local day containing `date`. Drives the water ring.
export async function fetchHydrationTotal(date = new Date()) {
  const supabase = await getSupabaseClient();
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  const { data, error } = await supabase
    .from("hydration_logs")
    .select("id, ml, occurred_at")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  return { ml: rows.reduce((sum, r) => sum + (Number(r.ml) || 0), 0), rows };
}

// Undo the most recent water tap (mis-taps are the whole risk of a one-tap UI).
export async function undoLastHydration() {
  const supabase = await getSupabaseClient();
  const { rows } = await fetchHydrationTotal(new Date());
  const last = rows[0];
  if (!last) return null;
  const { error } = await supabase.from("hydration_logs").delete().eq("id", last.id);
  if (error) throw error;
  return last;
}

// ---- sleep ----
// An OPEN session (ended_at null) means "asleep right now". There is at most one
// per user (enforced by a partial unique index), so a double tap cannot strand a
// second open row.

export async function fetchOpenSleepSession() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("sleep_sessions")
    .select("id, started_at, ended_at")
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

export async function startSleepSession(at = new Date()) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const open = await fetchOpenSleepSession();
  if (open) return open; // already asleep - tapping again is a no-op, not an error
  const { data, error } = await supabase
    .from("sleep_sessions")
    .insert({ user_id: userId, started_at: at.toISOString(), source: "button" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Close the open session. Returns { row, hours } or null when nothing was open.
export async function endSleepSession(at = new Date()) {
  const supabase = await getSupabaseClient();
  const open = await fetchOpenSleepSession();
  if (!open) return null;
  const { data, error } = await supabase
    .from("sleep_sessions")
    .update({ ended_at: at.toISOString() })
    .eq("id", open.id)
    .select()
    .single();
  if (error) throw error;
  const hours = (new Date(data.ended_at) - new Date(data.started_at)) / 3600000;
  return { row: data, hours: Math.round(hours * 10) / 10 };
}

// ---- gym: answered either way ----
// `status` is the whole point: a 'skipped' row records that the day was answered
// without counting as training, so the streak stays honest and the evening nudge
// stops asking.
export async function logGymAnswer(status, { description = null, occurredAt = null } = {}) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const safe = status === "skipped" || status === "rest" ? status : "done";
  const { data, error } = await supabase
    .from("workout_logs")
    .insert({
      user_id: userId,
      description: description || (safe === "done" ? "Gym - logged from Home" : "No gym today"),
      status: safe,
      occurred_at: (occurredAt ? new Date(occurredAt) : new Date()).toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Today's gym answer, if any - so the buttons render their current state.
export async function fetchTodayGymAnswer(date = new Date()) {
  const supabase = await getSupabaseClient();
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  const { data, error } = await supabase
    .from("workout_logs")
    .select("id, description, status, occurred_at")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

export async function fetchWorkoutLogs({ limit = 200 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("workout_logs")
    .select("id, description, duration_min, intensity, sets, bodyweight_kg, notes, occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Fetch the food logs + expense ledger rows the recurring-spend detector
// (lib/spend-patterns.mjs) learns from: "you've paid Rs 110 for this same lunch
// four times". Only the two tables and columns detectPatterns actually reads -
// keep it lean so it stays cheap to call on capture. A read error THROWS (never
// returns []): a failed history read must be visibly different from "no history
// yet", or the detector would silently forget every learned pattern.
export async function fetchSpendPatternHistory({ sinceDays = 120, limit = 2000 } = {}) {
  const supabase = await getSupabaseClient();
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const [food, ledger] = await Promise.all([
    supabase
      .from("food_logs")
      .select("id, ingestion_id, occurred_at, meal_name, description")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(limit),
    supabase
      .from("ledger_entries")
      .select("id, ingestion_id, occurred_at, merchant, description, amount, direction")
      // Only real spend carries a price signal; a merged-away duplicate must not
      // be counted as a second sighting of the same meal.
      .eq("direction", "expense")
      .is("merged_into", null)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(limit),
  ]);
  if (food.error) throw food.error;
  if (ledger.error) throw ledger.error;
  // Tag each row with its source table so the detector never has to guess money
  // vs food from the shape of a row.
  const foodRows = (food.data || []).map((r) => ({ ...r, table: "food_logs" }));
  const ledgerRows = (ledger.data || []).map((r) => ({ ...r, table: "ledger_entries" }));
  return { foodLogs: foodRows, ledgerEntries: ledgerRows, rows: [...foodRows, ...ledgerRows] };
}

// Fetch every food / workout / hydration row that falls on one local calendar
// day, for the diet hub's date stepper + auto check-off reconciler. `date` is a
// JS Date; the day window is its local midnight → next midnight.
export async function fetchDayLogs(date = new Date()) {
  const supabase = await getSupabaseClient();
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  const inDay = (q) => q.gte("occurred_at", start.toISOString()).lt("occurred_at", end.toISOString());
  const [food, workout, hydration] = await Promise.all([
    inDay(supabase.from("food_logs").select("id, occurred_at, meal_name, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g")),
    inDay(supabase.from("workout_logs").select("id, occurred_at, description, duration_min, intensity")),
    inDay(supabase.from("hydration_logs").select("id, occurred_at, ml")),
  ]);
  if (food.error) throw food.error;
  if (workout.error) throw workout.error;
  if (hydration.error) throw hydration.error;
  return { foodLogs: food.data || [], workoutLogs: workout.data || [], hydrationLogs: hydration.data || [] };
}

// Log one gym session = one workout_logs row. `sets` is the per-exercise array
// [{exercise, muscle, set, reps, weight_kg, done}]; total_volume is denormalised
// into duration-independent reporting by the UI/analytics from sets.
export async function logWorkoutSession({ description, duration_min = null, intensity = null, sets = [], bodyweight_kg = null, notes = null, occurred_at = null } = {}) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("workout_logs")
    .insert({
      user_id: userId,
      description: description || "Workout",
      duration_min, intensity,
      sets: Array.isArray(sets) ? sets : [],
      bodyweight_kg: bodyweight_kg == null ? null : Number(bodyweight_kg),
      notes,
      occurred_at: occurred_at || new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Log a body-composition data point (weight, body_fat_pct, waist_cm, …) into the
// existing body_metrics table - no separate measurements table.
export async function logBodyMetric({ metric_type, value, unit = "", occurred_at = null } = {}) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("body_metrics")
    .insert({ user_id: userId, metric_type, value: Number(value), unit, occurred_at: occurred_at || new Date().toISOString() })
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

// Active diet/gym plans (latest first). The latest permanent diet plan is the
// override the diet hub applies; older rows are the change history (undo target).
export async function fetchUserPlans({ limit = 20 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("user_plans")
    .select("id, kind, scope, summary, payload, created_at")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Open notes/aspirations/todos (newest first) for the feed + context.
export async function fetchNotes({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("notes")
    .select("id, kind, body, domain, status, due_on, event_group_id, occurred_at, created_at")
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Durable long-term memory facts, highest-confidence first.
export async function fetchMemoryFacts({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("memory_facts")
    .select("id, key, value, kind, confidence, source, updated_at")
    .order("confidence", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// AI-made target/budget changes (the note→target cascade), newest first, for the
// undoable feed. Only the auto-applied set_target audit rows.
export async function fetchTargetEvents({ limit = 20 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("audit_log")
    .select("id, action, before, after, created_at")
    .eq("action", "set_target")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Undo a target change: restore the prior amount (or delete the budget if there
// was none before). Mirrors revertTarget() in lib/aspiration-cascade.mjs.
export async function revertTargetEvent(auditId) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data: evt, error } = await supabase
    .from("audit_log").select("before, after").eq("id", auditId).single();
  if (error) throw error;
  const kind = evt?.after?.kind || evt?.before?.kind;
  if (!kind) return;
  const prior = evt?.before?.amount;
  if (prior == null) {
    await supabase.from("budgets").delete().eq("user_id", userId).eq("kind", kind);
  } else {
    await supabase.from("budgets")
      .update({ amount: prior }).eq("user_id", userId).eq("kind", kind);
  }
  // Remove the audit row so the undo affordance disappears from the feed.
  await supabase.from("audit_log").delete().eq("id", auditId);
}

export async function logMealFromTemplate(template) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  // instantiate() carries a source_template_id helper field that is not a
  // food_logs column - strip it before insert.
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

// ---- proactive briefings ----

// The one briefing row for a given slot + date (unique per user,kind,for_date).
export async function fetchBriefingFor({ kind, forDate }) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("briefings")
    .select("id, kind, for_date, body, payload, seen, created_at")
    .eq("kind", kind)
    .eq("for_date", forDate)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// The freshest briefing for a date regardless of kind - the scheduled jarvis fn
// writes morning/evening rows server-side, so Home shows whichever landed last.
export async function fetchLatestBriefing(forDate) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("briefings")
    .select("id, kind, for_date, body, payload, seen, created_at")
    .eq("for_date", forDate)
    .in("kind", ["morning", "evening"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

// Upsert today's briefing so it persists (not regenerated on every open).
export async function upsertBriefing({ kind, for_date, body, payload = {} }) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("briefings")
    .upsert({ user_id: userId, kind, for_date, body, payload }, { onConflict: "user_id,kind,for_date" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markBriefingSeen(id) {
  if (!id) return;
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("briefings").update({ seen: true }).eq("id", id);
  if (error) throw error;
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

// Raw-query audit: every capture in the last `sinceDays`, plus the AI run that
// processed it and the tool calls it produced. Three small windowed queries,
// joined client-side by buildAuditEntries() (pure) - avoids depending on
// PostgREST embeds and keeps the join unit-testable.
export async function fetchRawQueryAudit({ sinceDays = 7, limit = 200 } = {}) {
  const supabase = await getSupabaseClient();
  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const [ing, runs, actions] = await Promise.all([
    supabase.from("raw_ingestions")
      .select("id, source_type, capture_mode, raw_text, occurred_at, status, created_at")
      .gte("created_at", cutoff).order("created_at", { ascending: false }).limit(limit),
    supabase.from("ai_runs")
      .select("id, ingestion_id, provider, model, prompt_tokens, output_tokens, estimated_cost_usd, latency_ms, status, error_message, created_at")
      .gte("created_at", cutoff).limit(limit * 3),
    supabase.from("ai_actions")
      .select("id, ingestion_id, ai_run_id, tool_name, arguments, confidence, status, applied_record_table, applied_record_id, created_at")
      .gte("created_at", cutoff).limit(limit * 8),
  ]);
  if (ing.error) throw ing.error;
  if (runs.error) throw runs.error;
  if (actions.error) throw actions.error;
  return { ingestions: ing.data || [], runs: runs.data || [], actions: actions.data || [] };
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
    .select("id, kind, period, amount, starts_on, category_id")
    .order("starts_on", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Upsert a budget/goal by its stable `kind` so editing it anywhere updates the
// ONE canonical row (no duplicate budget rows). Falls back to insert if no kind.
export async function upsertBudget({ kind = null, period, amount, startsOn, categoryId = null }) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const row = { user_id: userId, kind, period, amount, starts_on: startsOn || monthStartIso(), category_id: categoryId };
  const query = kind
    ? supabase.from("budgets").upsert(row, { onConflict: "user_id,kind" })
    : supabase.from("budgets").insert(row);
  const { data, error } = await query.select().single();
  if (error) throw error;
  return data;
}

function monthStartIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
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

// fetchDuplicates() only carries table+id references - the audit page needs the
// actual amount/merchant/description to show the user what the pair IS. Only
// ledger_entries pairs exist today (dedupe-scan.js is money-only); resolve
// whichever tables show up so this doesn't silently break if that ever changes.
export async function fetchOpenDuplicatesWithRecords({ limit = 50 } = {}) {
  const candidates = await fetchDuplicates({ limit });
  if (!candidates.length) return [];
  const supabase = await getSupabaseClient();
  const byTable = new Map();
  for (const c of candidates) {
    for (const [table, id] of [[c.record_a_table, c.record_a_id], [c.record_b_table, c.record_b_id]]) {
      if (!byTable.has(table)) byTable.set(table, new Set());
      byTable.get(table).add(id);
    }
  }
  const recordsByKey = new Map(); // `${table}:${id}` -> row
  for (const [table, idSet] of byTable) {
    if (table !== "ledger_entries") continue; // no other domain populates this table yet
    const { data, error } = await supabase
      .from("ledger_entries")
      .select("id, amount, merchant, description, occurred_at, duplicate_state")
      .in("id", [...idSet]);
    if (error) throw error;
    for (const row of data || []) recordsByKey.set(`${table}:${row.id}`, row);
  }
  return candidates.map((c) => ({
    ...c,
    a: recordsByKey.get(`${c.record_a_table}:${c.record_a_id}`) || null,
    b: recordsByKey.get(`${c.record_b_table}:${c.record_b_id}`) || null,
  }));
}

// Merge = one of the pair was a real repeat capture of the same event: delete
// the loser, keep the survivor, close out the candidate. Dismiss = not actually
// a duplicate (e.g. a genuine recurring expense): just close the candidate.
export async function resolveDuplicateMerge({ candidateId, dropTable, dropId }) {
  await deleteRow(dropTable, dropId);
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("duplicate_candidates").update({ status: "resolved" }).eq("id", candidateId);
  if (error) throw error;
}

export async function dismissDuplicate(candidateId) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("duplicate_candidates").update({ status: "dismissed" }).eq("id", candidateId);
  if (error) throw error;
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
    // Keyed tools (set_target_candidate, remember_fact) upsert the single
    // canonical row; everything else inserts.
    const q = built.conflictTarget
      ? supabase.from(built.table).upsert(built.row, { onConflict: built.conflictTarget })
      : supabase.from(built.table).insert(built.row);
    const { data, error } = await q.select().single();
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

// Generic single-row delete for the additions feed's ✕. Whitelisted to the
// user-owned domain tables; RLS also enforces ownership on the server.
const DELETABLE_TABLES = new Set([
  "ledger_entries", "food_logs", "workout_logs", "body_metrics", "wellness_logs", "hydration_logs", "user_plans",
  "notes", "memory_facts",
]);
export async function deleteRow(table, id) {
  if (!DELETABLE_TABLES.has(table)) throw new Error(`delete not allowed for ${table}`);
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { error } = await supabase.from(table).delete().eq("id", id).eq("user_id", userId);
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
  "hydration_logs", "weekly_reviews", "user_plans", "notes", "memory_facts",
  "briefings", "audit_log", "media_assets", "raw_ingestions",
];

// ---- bank statement -> ledger promotion ----
// statement_rows were being written and then never read by anything that counts
// money, so every imported bank row was invisible in every total. These are the
// primitives the promoter in services/statement-import.js runs on.

// Rows that have never reached the ledger. ledger_entry_id is the promotion
// marker: set = this row already has its entry, so it can never be counted twice.
export async function fetchUnpromotedStatementRows({ importId = null, limit = 2000 } = {}) {
  const supabase = await getSupabaseClient();
  let query = supabase
    .from("statement_rows")
    .select("id, import_id, occurred_on, description, debit, credit, balance, reference, ledger_entry_id")
    .is("ledger_entry_id", null)
    .order("occurred_on", { ascending: true })
    .limit(limit);
  if (importId) query = query.eq("import_id", importId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Statement-sourced entries already in the ledger over an inclusive day range,
// so a re-import can recognise its own earlier rows by content.
export async function fetchStatementLedgerEntries({ fromDate, toDate }) {
  const supabase = await getSupabaseClient();
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  const start = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td + 1);
  const { data, error } = await supabase
    .from("ledger_entries")
    .select("id, amount, direction, occurred_at, merchant, description, reference, source_type")
    .eq("source_type", "statement")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString());
  if (error) throw error;
  return data || [];
}

// One entry per call so a single bad row is attributable instead of failing a
// whole batch and leaving the user guessing which transaction broke.
export async function insertStatementLedgerEntry(entry) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("ledger_entries")
    .insert({ ...entry, user_id: userId })
    .select("id")
    .single();
  if (error) throw error;
  return data;
}

export async function markStatementRowPromoted(statementRowId, ledgerEntryId) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from("statement_rows")
    .update({ ledger_entry_id: ledgerEntryId, promoted_at: new Date().toISOString(), promotion_error: null })
    .eq("id", statementRowId);
  if (error) throw error;
}

// Persist WHY a row could not be promoted, so the reason survives the toast and
// the row does not silently sit unpromoted forever with no explanation.
export async function markStatementRowUnpromotable(statementRowId, reason) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from("statement_rows")
    .update({ promotion_error: reason })
    .eq("id", statementRowId);
  if (error) throw error;
}

// Statement rows still missing from the ledger, across every import. Returns
// null when the server gives no count - an unknown backlog is not a backlog of 0.
export async function countUnpromotedStatementRows() {
  const supabase = await getSupabaseClient();
  const { count, error } = await supabase
    .from("statement_rows")
    .select("id", { count: "exact", head: true })
    .is("ledger_entry_id", null);
  if (error) throw error;
  return count == null ? null : count;
}

export async function setStatementImportStatus(importId, status) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("statement_imports").update({ status }).eq("id", importId);
  if (error) throw error;
}

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
