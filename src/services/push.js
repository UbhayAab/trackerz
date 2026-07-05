// Web Push subscription mechanics (browser side). The server half lives in the
// jarvis edge function, which signs pushes with the VAPID private key stored in
// app_secrets (JARVIS_VAPID_JWK). This public key is the matching half — it is
// safe in client code by design and is printed by scripts/generate-vapid-keys.mjs.

import { savePushSubscription, removePushSubscription } from "./jarvis.js";

export const VAPID_PUBLIC_KEY = "BMtFWk6Vjl8ijfOG-8aQPW-78g22UHAhsFo707tQXRZkPs0FFfMVTAf0QsfH-bbAkE1rH0-BGTVx3zBC1uXfg-w";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;
}

// "granted" | "denied" | "default" | "unsupported", plus whether this browser
// currently holds a live subscription.
export async function getPushState() {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false };
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    subscribed = Boolean(await reg.pushManager.getSubscription());
  } catch { /* no SW yet */ }
  return { permission: Notification.permission, subscribed };
}

// Ask permission, subscribe this browser, and persist the endpoint so the
// jarvis edge fn can reach it. Returns { ok, reason? }.
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  const json = sub.toJSON();
  await savePushSubscription({ endpoint: json.endpoint, keys: json.keys, ua: navigator.userAgent.slice(0, 200) });
  return { ok: true };
}

// Unsubscribe this browser and drop its endpoint row.
export async function disablePush() {
  if (!pushSupported()) return { ok: true };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await removePushSubscription(endpoint);
    }
  } catch { /* best-effort */ }
  return { ok: true };
}
