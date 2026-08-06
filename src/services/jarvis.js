// Jarvis engine app service: profile delivery preferences, push-subscription
// persistence, and on-demand invocation of the `jarvis` edge function ("Brief me
// now" / diagnostics). DOM-free; the UI half is src/ui/jarvis-settings.js.

import { getSupabaseClient } from "./supabase-client.js";

async function requireUserId(supabase) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) throw new Error("not_signed_in");
  return data.user.id;
}

// The profile row IS the Jarvis config: briefing_enabled (master switch),
// email_brief, push_enabled, quiet_hours, timezone.
export async function fetchJarvisProfile() {
  const supabase = await getSupabaseClient();
  const userId = await requireUserId(supabase);
  const { data, error } = await supabase
    .from("profiles")
    .select("briefing_enabled, email_brief, push_enabled, quiet_hours, timezone, display_name, autonomy_enabled")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateJarvisPrefs(patch) {
  const supabase = await getSupabaseClient();
  const userId = await requireUserId(supabase);
  const allowed = {};
  for (const key of ["briefing_enabled", "email_brief", "push_enabled", "quiet_hours"]) {
    if (key in patch) allowed[key] = patch[key];
  }
  const { error } = await supabase.from("profiles").update(allowed).eq("id", userId);
  if (error) throw error;
  return true;
}

export async function savePushSubscription({ endpoint, keys, ua = "" }) {
  if (!endpoint || !keys) throw new Error("bad_subscription");
  const supabase = await getSupabaseClient();
  const userId = await requireUserId(supabase);
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert({ user_id: userId, endpoint, keys, ua }, { onConflict: "endpoint" });
  if (error) throw error;
  return true;
}

export async function removePushSubscription(endpoint) {
  if (!endpoint) return false;
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
  return true;
}

// Invoke the jarvis edge function as the signed-in user (it scopes to you).
// action: "morning" | "midday" | "evening" | "closeout" | "task" | "status".
export async function runJarvisNow(action = "morning", { force = true } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("jarvis", { body: { action, force } });
  if (error) throw error;
  if (data && data.ok === false) throw new Error(data.error || "jarvis_failed");
  return data;
}

// ---- the calendar --------------------------------------------------------
//
// Reminder rows are calendar RULES, not events - the next occurrence is computed
// in-process by lib/reminders.mjs, so there is no date filtering here and the UI
// and the jarvis engine cannot disagree about when something is next due.
//
// This lives here rather than in supabase-data.js because of the modifier
// columns: a rule stored WITH an interval and read WITHOUT it silently degrades
// to "every week", which is a wrong date shown with total confidence. One column
// list, next to the code that depends on it.
const REMINDER_COLUMNS = "id, title, note, kind, freq, day_of_month, month_of_year, weekday, on_date, lead_days, active, created_at"
  + ", rule_interval, dtstart, nth_weekday, weekdays, until, max_count, exdates, rdates, at_time, timezone";

export async function fetchCalendarReminders() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("reminders")
    .select(REMINDER_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Every fire the engine has already CLAIMED, so the UI can show "announced" and
// never re-promise a notification that has been and gone.
export async function fetchReminderFires({ sinceDays = 60 } = {}) {
  const supabase = await getSupabaseClient();
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { data, error } = await supabase
    .from("reminder_fires")
    .select("reminder_id, occurrence_key, channel, fired_at")
    .gte("fired_at", since);
  if (error) throw error;
  return data || [];
}

// ---- agent tasks ---------------------------------------------------------

export async function fetchAgentTasks({ limit = 50 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("agent_tasks")
    .select("id, fire_at, tz, recurrence, intent, prompt, created_by, status, depth, runs, consecutive_failures, disabled_reason, last_run_at")
    .order("fire_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// The last few runs of one task, so "it went quiet" is answerable. A silent run
// has a row of its own - that is the whole point of logging silence.
export async function fetchAgentTaskRuns(taskId, { limit = 10 } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from("agent_task_runs")
    .select("id, slot_key, status, result, actions, cost_usd, started_at, finished_at")
    .eq("task_id", taskId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// A task the USER scheduled: depth 0, created_by 'user'. The client cannot set
// depth or created_by to anything else that matters - the server re-checks both,
// because a client flag cannot govern a server-side agent.
export async function createAgentTask(task) {
  const supabase = await getSupabaseClient();
  const userId = await requireUserId(supabase);
  const { data, error } = await supabase
    .from("agent_tasks")
    .insert({ ...task, user_id: userId, created_by: "user", depth: 0 })
    .select().single();
  if (error) throw error;
  return data;
}

export async function setAgentTaskStatus(id, status) {
  const supabase = await getSupabaseClient();
  const patch = { status, updated_at: new Date().toISOString() };
  // Re-enabling has to clear the breaker, or the next tick trips it again on the
  // stale count and the task looks like it silently refuses to come back.
  if (status === "scheduled") { patch.consecutive_failures = 0; patch.disabled_reason = null; }
  const { error } = await supabase.from("agent_tasks").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteAgentTask(id) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("agent_tasks").delete().eq("id", id);
  if (error) throw error;
}

// The autonomy master switch, read and written where the user can see it.
// Authoritative enforcement is server-side (jarvis reads profiles.autonomy_enabled
// FIRST and fails closed); this is only the control surface.
export async function setAutonomyEnabled(enabled) {
  const supabase = await getSupabaseClient();
  const userId = await requireUserId(supabase);
  const { error } = await supabase.from("profiles").update({ autonomy_enabled: Boolean(enabled) }).eq("id", userId);
  if (error) throw error;
  return true;
}
