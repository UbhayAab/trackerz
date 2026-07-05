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
    .select("briefing_enabled, email_brief, push_enabled, quiet_hours, timezone, display_name")
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
// action: "morning" | "evening" | "closeout" | "status".
export async function runJarvisNow(action = "morning", { force = true } = {}) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("jarvis", { body: { action, force } });
  if (error) throw error;
  if (data && data.ok === false) throw new Error(data.error || "jarvis_failed");
  return data;
}
