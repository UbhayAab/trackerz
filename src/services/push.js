// Web Push registration. Asks for notification permission, subscribes this
// device with the server's VAPID public key (served by the `nightly` edge fn —
// nothing baked into the client), and stores the subscription in
// push_subscriptions (RLS: own rows only). The nightly cron then reaches this
// device even with the app closed. iOS caveat: Safari only delivers web push to
// a PWA added to the Home Screen, not a tab.

import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";

function requireUserId() {
  const session = getCurrentSession();
  if (!session?.user?.id) throw new Error("not_authenticated");
  return session.user.id;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;
}

// base64url VAPID key -> Uint8Array applicationServerKey.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function fetchVapidPublicKey() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("nightly", { body: { op: "vapid" } });
  if (error) throw new Error(`vapid key fetch failed: ${error.message || error}`);
  if (!data?.publicKey) throw new Error(data?.error || "vapid_not_configured");
  return data.publicKey;
}

// Current state for the settings UI: "unsupported" | "denied" | "subscribed" | "off".
export async function getPushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? "subscribed" : "off";
}

// Ask permission, subscribe this device, persist the subscription row.
export async function enablePush() {
  if (!pushSupported()) throw new Error("push_unsupported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission_denied");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const publicKey = await fetchVapidPublicKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: requireUserId(),
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh || "",
    auth: json.keys?.auth || "",
    user_agent: navigator.userAgent.slice(0, 200),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "user_id,endpoint" });
  if (error) throw error;
  return "subscribed";
}

// Unsubscribe this device and drop its row.
export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const supabase = await getSupabaseClient();
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint).catch(() => null);
    await sub.unsubscribe().catch(() => null);
  }
  return "off";
}

// Server-side test: the nightly fn pushes a real notification to every device
// this user has registered — proves the whole VAPID/encryption path, not just
// local permission.
export async function sendTestPush() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("nightly", { body: { op: "test-push" } });
  if (error) throw new Error(`test push failed: ${error.message || error}`);
  return data;
}

// Generate + push my briefing right now (also exercised by the settings UI).
export async function runMyBriefingNow(slot) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("nightly", {
    body: { op: "run-self", ...(slot ? { slot } : {}) },
  });
  if (error) throw new Error(`briefing run failed: ${error.message || error}`);
  return data;
}
