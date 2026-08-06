import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import { buildRowForTool } from "./action-applier.js";
import { applyAmendment } from "./undo-service.js";
import { instantiate } from "../domain/diet/meal-templates.js";
import { clampSleepSpan } from "../../lib/sleep-window.mjs";
import { rowForRepeat } from "../../lib/meal-repeats.mjs";
import { WATER_GOAL_KIND, WATER_GOAL_MAX_ML, clampGoalMl } from "../../lib/water.mjs";
import { SOFT_DELETABLE_TABLES } from "../../lib/undo-ledger.mjs";
import { isPlanDelta } from "../../lib/plan-merge.mjs";

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
    // flow_type and counts_as_spending travel with every row so the money page
    // can tell a grocery run from a credit-card bill. Without them a statement
    // import makes "you spent Rs 8.26 lakh" true of the bank and false of you.
    .select("id, occurred_at, merchant, description, amount, currency, direction, payment_mode, duplicate_state, confidence, is_discretionary, tags, merged_into, flow_type, counterparty, counts_as_spending, counts_as_income, account_id, rail")
    // A merged-away duplicate must not be counted again. This function feeds
    // EVERY browser-side money number (the month tile, the period aggregator,
    // opportunity cost, exports), so without this filter merging a duplicate
    // would visibly change nothing - the whole point of the merge.
    .is("merged_into", null)
    // Tombstoned rows are gone as far as every number in the app is concerned.
    // This is the read that feeds every money total, so a deleted row that leaked
    // through here would still be counted while the user believed it removed.
    .is("deleted_at", null)
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
    .is("deleted_at", null)
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
    .is("deleted_at", null)
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
    .is("deleted_at", null)
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

// Write N taps as ONE insert.
//
// The water button is optimistic: six thumb taps in three seconds are six real
// glasses, and they arrive here as one batch a beat after the last tap. Sending
// them as six sequential inserts would put the round-trip cost back into the
// interaction it was removed from, so this is a single statement.
//
// Each row gets its own occurred_at, 1 ms apart, because rows written in the same
// statement otherwise share a timestamp and "delete the newest row" (undo) then
// picks an arbitrary one of the six. With mixed sizes in a batch - a 250 and a
// 1000 - that is undo removing the wrong drink.
export async function logHydrationBatch(mls) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const amounts = (Array.isArray(mls) ? mls : [mls])
    .map((ml) => Math.round(Number(ml) || 0))
    .filter((ml) => ml > 0);
  if (!amounts.length) return [];
  const base = Date.now();
  const rows = amounts.map((ml, i) => ({
    user_id: userId,
    ml,
    occurred_at: new Date(base + i).toISOString(),
  }));
  const { data, error } = await supabase.from("hydration_logs").insert(rows).select();
  if (error) throw error;
  return data || [];
}

export async function logHydration(ml) {
  const rows = await logHydrationBatch([ml]);
  return rows[0] || null;
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
    .is("deleted_at", null)
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    // id descending is the tiebreak for rows written by one batched insert. Two
    // rows with the same occurred_at would otherwise come back in whatever order
    // Postgres felt like, and rows[0] is what undo deletes.
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  return { ml: rows.reduce((sum, r) => sum + (Number(r.ml) || 0), 0), rows };
}

// Undo the most recent water tap (mis-taps are the whole risk of a one-tap UI).
//
// SCOPED TO TODAY, deliberately. It reads through fetchHydrationTotal, whose
// window is [local midnight, next local midnight) - so on a day with zero logs
// there is no row to take and this returns null. It must never fall through to
// yesterday's last glass, which is what a bare "newest row overall" query would
// delete on the first tap of a new morning.
export async function undoLastHydration() {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { rows } = await fetchHydrationTotal(new Date());
  const last = rows[0];
  if (!last) return null;
  // Tombstone, not a hard delete - fetchHydrationTotal filters `deleted_at`, so
  // the ring drops by exactly one glass either way, and a mis-tapped undo is
  // itself recoverable.
  const { error } = await supabase
    .from("hydration_logs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", last.id).eq("user_id", userId).is("deleted_at", null);
  if (error) throw error;
  return last;
}

// ---- the daily water goal ----
//
// It used to be derived-only (the diet scaffold's schedule summed to 3450), so
// "set my water goal to 4L" had nowhere to write and silently did nothing. It is
// now a normal kind-keyed `budgets` row like every other target, read and written
// through the same upsertBudget path so there is ONE canonical row per user.
// Returns null when the user has never set one - the caller falls back to the
// scaffold sum via resolveGoalMl rather than to a second hardcoded number.
export async function fetchWaterGoalMl() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("budgets")
    .select("amount")
    .eq("kind", WATER_GOAL_KIND)
    .limit(1);
  if (error) throw error;
  const amount = (data || [])[0]?.amount;
  return amount == null ? null : clampGoalMl(amount);
}

// Clamped BEFORE it is stored: a goal of 0 made the meter Math.round(x/0*100),
// i.e. width:Infinity%, and rejecting it here means a bad value cannot be
// persisted for the next session to trip over.
export async function setWaterGoalMl(ml) {
  const clamped = clampGoalMl(ml);
  if (clamped === null) throw new Error(`Water goal must be between 1 and ${WATER_GOAL_MAX_ML} ml.`);
  await upsertBudget({ kind: WATER_GOAL_KIND, period: "daily", amount: clamped });
  return clamped;
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
    .is("deleted_at", null)
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

// Close the open session. Returns { row, hours, capped } or null when nothing
// was open. A span longer than SLEEP_MAX_HOURS almost always means a forgotten
// tap (the 11-hour bug), so it is capped and flagged rather than recorded as a
// real night. The caller offers a wake-time adjuster for exactly this reason.
export async function endSleepSession(at = new Date()) {
  const supabase = await getSupabaseClient();
  const open = await fetchOpenSleepSession();
  if (!open) return null;
  const clamp = clampSleepSpan(open.started_at, at.toISOString());
  const update = { ended_at: clamp.ended_at };
  if (clamp.capped) update.note = "approx - capped, tapped late; adjust wake time if wrong";
  const { data, error } = await supabase
    .from("sleep_sessions")
    .update(update)
    .eq("id", open.id)
    .select()
    .single();
  if (error) throw error;
  return { row: data, hours: clamp.hours, capped: clamp.capped };
}

// Correct a session's wake time after the fact - the forgiving path for "I woke
// at 7 but tapped at 11". Recomputes the flag: an adjusted, plausible span drops
// the "approx" note.
export async function adjustSleepWake(sessionId, wakeAt) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data: rows, error: readErr } = await supabase
    .from("sleep_sessions").select("id, started_at").is("deleted_at", null).eq("id", sessionId).limit(1);
  if (readErr) throw readErr;
  const row = (rows || [])[0];
  if (!row) throw new Error("sleep session not found");
  const clamp = clampSleepSpan(row.started_at, new Date(wakeAt).toISOString());
  if (clamp.hours == null) throw new Error("wake time must be after you went to sleep");
  const { data, error } = await supabase
    .from("sleep_sessions")
    .update({ ended_at: clamp.ended_at, note: clamp.capped ? "approx - capped" : null })
    .eq("id", sessionId).eq("user_id", userId)
    .select().single();
  if (error) throw error;
  return { row: data, hours: clamp.hours, capped: clamp.capped };
}

// Completed sleep sessions for the analytics/brief windows. Open sessions are
// excluded - a night with no wake time has no duration to report.
export async function fetchSleepSessions({ limit = 120 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("sleep_sessions")
    .select("id, started_at, ended_at, quality, source, note")
    .is("deleted_at", null)
    .not("ended_at", "is", null)
    .order("ended_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
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
//
// Reads the WHOLE day, not just the newest row. Logging exercises on the Gym page
// writes rows that this used to miss whenever anything else landed afterwards, so
// Home still read "unanswered" and got tapped again - one gym trip, two rows.
// A real session outranks a "no gym" answer: if any done row exists for the day,
// the day was trained, regardless of what was tapped afterwards.
export async function fetchTodayGymAnswer(date = new Date()) {
  const supabase = await getSupabaseClient();
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  const { data, error } = await supabase
    .from("workout_logs")
    .select("id, description, status, occurred_at")
    .is("deleted_at", null)
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return null;
  // A null status predates the status column and means a logged session.
  return rows.find((r) => r.status === "done" || r.status == null) || rows[0];
}

export async function fetchWorkoutLogs({ limit = 200 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("workout_logs")
    // `status` is required by the gym intelligence engine (done vs skipped) - it
    // was omitted, which silently dropped every real row from the consistency,
    // streak, and weekly-volume insights.
    .select("id, description, status, duration_min, intensity, sets, bodyweight_kg, notes, occurred_at")
    .is("deleted_at", null)
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
      .is("deleted_at", null)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(limit),
    supabase
      .from("ledger_entries")
      .select("id, ingestion_id, occurred_at, merchant, description, amount, direction")
      // Only real spend carries a price signal; a merged-away duplicate must not
      // be counted as a second sighting of the same meal. counts_as_spending is
      // what keeps a Rs 25,000 mutual-fund debit from being read as lunch.
      .eq("direction", "expense")
      .eq("counts_as_spending", true)
      .is("merged_into", null)
      .is("deleted_at", null)
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
  // The tombstone filter is spelled out on each query rather than folded into
  // inDay(), because tests/soft-delete-contract.test.mjs reads each `.from(...)`
  // chain in isolation - and so does anyone skimming this function.
  const inDay = (q) => q.gte("occurred_at", start.toISOString()).lt("occurred_at", end.toISOString());
  const [food, workout, hydration] = await Promise.all([
    inDay(supabase.from("food_logs").select("id, occurred_at, meal_name, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g").is("deleted_at", null)),
    // `status` is NOT optional here. Without it the reconciler below cannot tell a
    // real session from a "no gym today" answer, so tapping Skipped on Home ticked
    // the plan's workout as DONE.
    inDay(supabase.from("workout_logs").select("id, occurred_at, description, duration_min, intensity, status, sets").is("deleted_at", null)),
    inDay(supabase.from("hydration_logs").select("id, occurred_at, ml").is("deleted_at", null)),
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
//
// THE WINDOW HAS TO CONTAIN A BASE. `user_plans` is append-only and
// foldPlanPayloads() walks a scope's rows oldest→newest over a FULL DOCUMENT: a
// full payload resets the accumulator, a delta merges onto it. A fixed `limit: 20`
// therefore breaks silently the moment a user accumulates 20 rows after their
// last full plan - the base falls out of the window, the fold starts from a delta
// with nothing under it, and the plan collapses to whatever that one delta says.
// Nothing errors; the diet hub just quietly shows one meal.
//
// So: page back until the newest FULL (non-delta) row for each kind is inside the
// window, and keep every row after it. `limit` is the page size now, not the cap.
export async function fetchUserPlans({ limit = 20, maxPages = 10 } = {}) {
  const supabase = await getSupabaseClient();
  const rows = [];
  const kindsNeedingBase = new Set(["diet", "gym"]);
  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await supabase
      .from("user_plans")
      .select("id, kind, scope, summary, payload, created_at")
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(page * limit, page * limit + limit - 1);
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    // A full document for a kind means everything older than it is unreachable
    // history - stop asking for it.
    for (const r of batch) {
      if (!isPlanDelta(r.payload)) kindsNeedingBase.delete(r.kind || "diet");
    }
    if (batch.length < limit || !kindsNeedingBase.size) break;
  }
  return rows;
}

// Open notes/aspirations/todos (newest first) for the feed + context.
export async function fetchNotes({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("notes")
    .select("id, kind, body, domain, status, due_on, event_group_id, occurred_at, created_at")
    .is("deleted_at", null)
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
    .select("id, key, value, kind, confidence, source, provenance, updated_at")
    .is("deleted_at", null)
    .order("confidence", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// AI-made target/budget changes (the note→target cascade), newest first, for the
// undoable feed.
//
// Reads BOTH the set_target rows and the revert_target rows that compensate them,
// then hides any change that has already been reverted. It used to read only
// set_target rows and rely on the undo DELETING its own audit row to make the
// affordance disappear - see revertTargetEvent below for why that was wrong.
export async function fetchTargetEvents({ limit = 20 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("audit_log")
    .select("id, action, target_id, before, after, created_at")
    .in("action", ["set_target", "revert_target"])
    .order("created_at", { ascending: false })
    .limit(limit * 2);
  if (error) throw error;
  const rows = data || [];
  const reverted = new Set(rows.filter((r) => r.action === "revert_target" && r.target_id).map((r) => r.target_id));
  return rows.filter((r) => r.action === "set_target" && !reverted.has(r.id)).slice(0, limit);
}

// Undo a target change: restore the prior amount (or clear the budget if there
// was none before). Mirrors revertTarget() in lib/aspiration-cascade.mjs.
//
// THIS USED TO DELETE THE audit_log ROW IT UNDID. The undo destroyed its own
// audit trail: after it ran, the app held no record that the target had ever been
// changed, no record that it had been changed BACK, and no way to answer "why is
// my protein goal 180" three weeks later. An audit log that a normal user action
// can erase is not an audit log. It now writes a COMPENSATING row instead -
// double-entry style, with before/after swapped and target_id pointing at the
// change it reverses - so the history reads forwards: set, then unset.
export async function revertTargetEvent(auditId) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data: evt, error } = await supabase
    .from("audit_log").select("id, before, after").eq("id", auditId).single();
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
  const { error: auditErr } = await supabase.from("audit_log").insert({
    user_id: userId,
    action: "revert_target",
    target_table: "budgets",
    target_id: auditId,
    before: evt?.after ?? null,
    after: evt?.before ?? null,
    source: "user",
  });
  if (auditErr) throw auditErr;
}

// One-tap repeat of a meal the user has already logged before. The row shape comes
// from lib/meal-repeats.mjs (median macros of that meal's own history), so this
// writes a real, complete food row with no model call and no cost.
export async function logRepeatMeal(chip, { now = new Date() } = {}) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const row = rowForRepeat(chip, { now });
  if (!row) throw new Error("Nothing to repeat.");
  const { data, error } = await supabase
    .from("food_logs")
    .insert({ user_id: userId, ...row })
    .select()
    .single();
  if (error) throw error;
  return data;
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
    // SOFT-DELETE ALLOWLIST: this read deliberately sees tombstones. It resolves
    // both halves of a duplicate PAIR for the audit card, and a pair with one side
    // deleted must still render as a pair - otherwise the card shows "duplicate
    // of (nothing)" and the user cannot tell what was matched.
    const { data, error } = await supabase
      .from("ledger_entries")
      .select("id, amount, merchant, description, occurred_at, duplicate_state, deleted_at")
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

// The two keyed tools UPSERT a single canonical row. When that row already
// exists the "write" is an EDIT of a value the user had before the AI ever
// spoke, so the prior values have to be read BEFORE the write or an undo has
// nothing to put back. Mirrors UPSERT_TOOLS in supabase/functions/agent/index.ts.
const UPSERT_TOOLS = {
  set_target_candidate: { table: "budgets", keyColumn: "kind", argKey: "kind", columns: ["amount", "period", "starts_on"] },
  remember_fact: { table: "memory_facts", keyColumn: "key", argKey: "key", columns: ["value", "kind", "confidence", "source", "provenance"] },
};

async function beforeImageFor(supabase, userId, action) {
  const spec = UPSERT_TOOLS[action?.tool_name];
  const keyValue = spec ? action?.arguments?.[spec.argKey] : null;
  if (!spec || !keyValue) return null;
  const { data } = await supabase
    .from(spec.table)
    .select(["id", spec.keyColumn, ...spec.columns].join(", "))
    .eq("user_id", userId).eq(spec.keyColumn, keyValue).maybeSingle();
  return data || null;
}

// Approve a proposed action: actually write the domain row (RLS-safe, user
// client) the way the server auto-apply path would, THEN mark the action
// applied with provenance AND a v2 undo_payload. Without that payload an
// approved action would be the one write in the app with no way back - which is
// exactly the hole the confirm gate would otherwise create, since consequential
// tools now arrive here instead of auto-applying on the server.
export async function applyProposedAction(action) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const built = buildRowForTool(action, userId);

  // AN AMENDMENT IS NOT AN INSERT. buildRowForTool returns a plan with an `op`
  // for the two destructive tools, and running it through the insert path below
  // would add a SECOND row - the exact bug amend_log_candidate exists to fix.
  //
  // A missing plan is reported, never applied. Without this branch the action
  // would be marked `applied` with a null record id: the audit trail claiming a
  // write that never happened, which is the failure this file's own comments
  // keep naming.
  if (built && built.op) {
    const result = await applyAmendment(built);
    if (!result.ok) throw new Error(`amend_failed:${result.reason}`);
    // The audit row. Append-only and never itself deleted - it is the only
    // record that a row the user is reading today is not the row they wrote.
    await supabase.from("audit_log").insert({
      user_id: userId,
      action: built.op === "soft_delete" ? "ai_delete_log" : "ai_amend_log",
      target_table: built.table, target_id: built.id,
      before: built.before || null,
      after: built.op === "soft_delete" ? null : built.row,
      source: "user",
    });
    const { error: amendErr } = await supabase.from("ai_actions").update({
      status: "applied",
      applied_at: new Date().toISOString(),
      applied_record_table: built.table,
      applied_record_id: built.id,
      undo_payload: result.undo,
    }).eq("id", action.id);
    if (amendErr) throw amendErr;
    return { id: action.id, appliedTable: built.table, appliedId: built.id, op: built.op };
  }

  let appliedTable = null;
  let appliedId = null;
  const before = built ? await beforeImageFor(supabase, userId, action) : null;

  // A target change is undoable from the feed only because a set_target audit row
  // exists. The server's applyTool writes one; this path did not, so a target
  // approved by hand landed with no history and no Undo button. Written BEFORE
  // the upsert, so `before.amount` is still the prior value.
  if (action?.tool_name === "set_target_candidate" && action?.arguments?.kind) {
    await supabase.from("audit_log").insert({
      user_id: userId, action: "set_target", target_table: "budgets", target_id: null,
      before: { kind: action.arguments.kind, amount: before?.amount ?? null },
      after: { kind: action.arguments.kind, amount: action.arguments.amount },
      source: "user",
    });
  }

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
  const spec = UPSERT_TOOLS[action?.tool_name];
  const { error: upErr } = await supabase
    .from("ai_actions")
    .update({
      status: "applied",
      applied_at: new Date().toISOString(),
      applied_record_table: appliedTable,
      applied_record_id: appliedId,
      undo_payload: appliedId
        ? {
          v: 2,
          op: spec ? "upsert" : "insert",
          table: appliedTable,
          id: appliedId,
          before: spec ? (before || null) : null,
          after: null,
          columns: spec && before ? spec.columns : [],
        }
        : null,
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
//
// It is now a SOFT delete: the row is tombstoned (`deleted_at`), every read
// filters it out, and only the 30-day purge really removes it. To the user
// nothing changed - the row vanishes from the feed and from every total - but the
// removal is now a reversible write with a before-image, which is the whole
// premise of undo. Hard delete survives only for `deleteAllUserData`.
const DELETABLE_TABLES = new Set(SOFT_DELETABLE_TABLES);
export async function deleteRow(table, id) {
  if (!DELETABLE_TABLES.has(table)) throw new Error(`delete not allowed for ${table}`);
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { error } = await supabase
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId)
    // Deleting an already-deleted row is a no-op, not a second delete: it must
    // never overwrite the original tombstone timestamp and restart the 30-day
    // purge clock on a row the user removed weeks ago.
    .is("deleted_at", null);
  if (error) throw error;
}

// Put a tombstoned row back. The other half of deleteRow, and what
// src/services/undo-service.js calls to reverse a delete. Returns false when
// there was nothing to restore (already live, or hard-gone) so the caller can
// report `target_missing` instead of claiming success.
export async function restoreRow(table, id) {
  if (!DELETABLE_TABLES.has(table)) throw new Error(`restore not allowed for ${table}`);
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from(table)
    .update({ deleted_at: null })
    .eq("id", id).eq("user_id", userId)
    .select("id");
  if (error) throw error;
  return Boolean((data || []).length);
}

// Server-side data erasure: wipe every row this user owns and their stored
// media. The profile row is kept so the account still works. RLS guarantees
// only the caller's own rows are touched.
// Order matters: ledger_links points at ledger_entries, and statement rows
// point at both entries and accounts, so children are cleared before parents.
// A table missing from this list survives "delete everything", which is how a
// user who asked to be forgotten stays half-remembered.
const USER_DATA_TABLES = [
  "ledger_links", "ai_actions", "ai_runs", "statement_rows", "statement_imports",
  "ledger_entries", "recurring_series", "bank_accounts",
  "food_logs", "body_metrics",
  "wellness_logs", "workout_logs",
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
  // SOFT-DELETE ALLOWLIST: re-import dedupe must see tombstones. If a deleted
  // bank row were invisible here, re-importing the same statement would recreate
  // the exact entry the user removed, every time.
  const { data, error } = await supabase
    .from("ledger_entries")
    .select("id, amount, direction, occurred_at, merchant, description, reference, source_type, deleted_at")
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

// ---- bank accounts, flow-typed entries and cross-row links ----
// The pipeline in lib/statement-ingest.mjs produces all of this; these are the
// only functions that put it in Postgres.

export async function fetchBankAccounts() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("bank_accounts")
    .select("id, bank, account_number, account_last4, ifsc, micr, customer_id, account_holder, nickname, vpas, last_balance, last_balance_on");
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    // Same key the pipeline derives, so a stored account and a freshly parsed
    // one collapse to one entity instead of importing the account twice.
    accountKey: row.account_number ? `acct:${row.account_number}` : `bank:${row.bank}:${row.account_last4}`,
    bank: row.bank,
    accountNumber: row.account_number,
    accountLast4: row.account_last4,
    ifsc: row.ifsc,
    micr: row.micr,
    customerId: row.customer_id,
    accountHolder: row.account_holder,
    nickname: row.nickname,
    vpas: row.vpas || [],
    lastBalance: row.last_balance,
    lastBalanceOn: row.last_balance_on,
  }));
}

export async function upsertBankAccount(account) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const payload = {
    user_id: userId,
    bank: account.bank,
    account_number: account.accountNumber,
    account_last4: account.accountLast4,
    ifsc: account.ifsc,
    micr: account.micr,
    customer_id: account.customerId,
    account_holder: account.accountHolder,
    vpas: account.vpas || [],
    last_balance: account.lastBalance ?? null,
    last_balance_on: account.lastBalanceOn ?? null,
    updated_at: new Date().toISOString(),
  };
  if (account.id) {
    const { data, error } = await supabase.from("bank_accounts").update(payload).eq("id", account.id).select("id").single();
    if (error) throw error;
    return data.id;
  }
  const { data, error } = await supabase
    .from("bank_accounts")
    .upsert(payload, { onConflict: "user_id,account_number" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function createStatementImport(record) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("statement_imports")
    .insert({ ...record, user_id: userId })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// Which of these content keys the user already has. Asked BEFORE writing
// anything, so a re-import is recognised up front and reported as "already
// there" rather than being discovered as a pile of constraint violations.
export async function fetchExistingStatementKeys(contentKeys) {
  const supabase = await getSupabaseClient();
  const found = new Set();
  const BATCH = 200;
  for (let i = 0; i < contentKeys.length; i += BATCH) {
    const slice = contentKeys.slice(i, i + BATCH);
    const { data, error } = await supabase.from("statement_rows").select("content_key").in("content_key", slice);
    if (error) throw error;
    for (const row of data || []) found.add(row.content_key);
  }
  return found;
}

export async function insertLedgerEntriesBatch(entries) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("ledger_entries")
    .insert(entries.map((e) => ({ ...e, user_id: userId })))
    .select("id");
  if (error) throw error;
  return (data || []).map((r) => r.id);
}

export async function insertStatementRowsBatch(rows) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  // Conflict target is (user_id, content_key) - content only. An import_id in
  // the key is freshly minted every upload and can never collide.
  const { data, error } = await supabase
    .from("statement_rows")
    .upsert(rows.map((r) => ({ ...r, user_id: userId })), { onConflict: "user_id,content_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

export async function insertLedgerLinks(links) {
  if (!links.length) return 0;
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("ledger_links")
    .upsert(links.map((l) => ({ ...l, user_id: userId })), { onConflict: "user_id,kind,from_entry_id,to_entry_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

export async function upsertRecurringSeries(series) {
  if (!series.length) return 0;
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("recurring_series")
    .upsert(
      series.map((s) => ({
        user_id: userId,
        series_key: s.key,
        counterparty: s.counterparty,
        direction: s.direction,
        cadence: s.cadence,
        amount: s.amount,
        amount_varies: s.amountVaries,
        occurrences: s.occurrences,
        first_seen: s.firstSeen,
        last_seen: s.lastSeen,
        expected_next: s.expectedNext,
        missed: s.missed,
        annualised: s.annualised,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "user_id,series_key" },
    )
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

// Hand-logged entries only. Bank rows dedupe by content key; these are the ones
// a bank row might be a second recording of, and they need scoring instead.
export async function fetchManualLedgerEntries({ fromDate, toDate }) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("ledger_entries")
    .select("id, amount, merchant, description, occurred_at, source_type")
    .is("deleted_at", null)
    .or("source_type.is.null,source_type.neq.statement")
    .gte("occurred_at", `${fromDate}T00:00:00Z`)
    .lte("occurred_at", `${toDate}T23:59:59Z`);
  if (error) throw error;
  return data || [];
}

export async function fetchRecurringSeries() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("recurring_series")
    .select("id, series_key, counterparty, direction, cadence, amount, occurrences, first_seen, last_seen, expected_next, missed, annualised")
    .order("annualised", { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---- recurring reminders ----------------------------------------------------
// Rows are calendar RULES, not events. The next occurrence is computed in-process
// by lib/reminders.mjs, so there is no date filtering here and the UI and the
// jarvis engine cannot disagree about when something is next due.

export async function fetchReminders() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("reminders")
    .select("id, title, note, kind, freq, day_of_month, month_of_year, weekday, on_date, lead_days, active, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createReminder(reminder) {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const { data, error } = await supabase
    .from("reminders")
    .insert({ ...reminder, user_id: userId })
    .select().single();
  if (error) throw error;
  return data;
}

export async function setReminderActive(id, active) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("reminders").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function deleteReminder(id) {
  // Soft delete like every other row the model can reach: a reminder that fires
  // every year is exactly the kind of thing you want back after deleting it by
  // mistake, and there is no way to retype a rule you no longer remember.
  await deleteRow("reminders", id);
}

export async function deleteAllUserData() {
  const supabase = await getSupabaseClient();
  const userId = requireUserId();
  const errors = [];
  for (const table of USER_DATA_TABLES) {
    // audit_log is APPEND-ONLY at the database level (migration
    // 20260806000070): it has no DELETE policy, because an audit trail an
    // ordinary action can erase is not one - and this app has already shipped an
    // undo that deleted the record of what it undid. The forget-me path is the
    // single legitimate erasure, so it goes through the one named door instead
    // of a standing permission.
    if (table === "audit_log") {
      const { error } = await supabase.rpc("erase_audit_log");
      if (error) errors.push(`${table}: ${error.message}`);
      continue;
    }
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
