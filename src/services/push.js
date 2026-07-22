// Web Push subscription mechanics (browser side). The server half lives in the
// jarvis edge function, which signs pushes with the VAPID private key stored in
// app_secrets (JARVIS_VAPID_JWK). This public key is the matching half - it is
// safe in client code by design and is printed by scripts/generate-vapid-keys.mjs.

import { savePushSubscription, removePushSubscription } from "./jarvis.js";
import { registerServiceWorker, isStandalone } from "./pwa.js";

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

// navigator.serviceWorker.ready is a promise that NEVER settles on a page that
// never registered a worker - it does not reject, it just hangs, which is how
// the settings page ended up permanently "checking" and no subscription was
// ever created. Register on demand and cap the wait so callers always get an
// answer they can show the user.
async function readyRegistration(timeoutMs = 8000) {
  await registerServiceWorker();
  let timer;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// "granted" | "denied" | "default" | "unsupported", plus whether this browser
// currently holds a live subscription. `ready` is false when we could not reach
// the service worker at all - in that case `subscribed` is unknown, not false,
// and the UI must not claim notifications are simply "off".
export async function getPushState() {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false, ready: false };
  const reg = await readyRegistration();
  if (!reg) return { permission: Notification.permission, subscribed: false, ready: false };
  try {
    const sub = await reg.pushManager.getSubscription();
    return { permission: Notification.permission, subscribed: Boolean(sub), ready: true, endpoint: sub?.endpoint || null };
  } catch (err) {
    return { permission: Notification.permission, subscribed: false, ready: false, error: err?.message || String(err) };
  }
}

// Ask permission, subscribe this browser, and persist the endpoint so the
// jarvis edge fn can reach it. Returns { ok, reason?, error? } - every failure
// mode is named so the caller can put it on screen.
export async function enablePush() {
  if (!pushSupported()) {
    return { ok: false, reason: isStandalone() ? "unsupported" : "unsupported_install_first" };
  }
  let permission = Notification.permission;
  if (permission !== "granted") permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission };

  const reg = await readyRegistration();
  if (!reg) return { ok: false, reason: "no_service_worker" };

  let sub;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
  } catch (err) {
    return { ok: false, reason: "subscribe_failed", error: err?.message || String(err) };
  }

  const json = sub.toJSON();
  try {
    await savePushSubscription({ endpoint: json.endpoint, keys: json.keys, ua: navigator.userAgent.slice(0, 200) });
  } catch (err) {
    // The browser is subscribed but the server can't reach it - that is a
    // failure, not a partial success. Say so instead of reporting "enabled".
    return { ok: false, reason: "save_failed", error: err?.message || String(err) };
  }
  return { ok: true, endpoint: json.endpoint };
}

// Unsubscribe this browser and drop its endpoint row.
export async function disablePush() {
  if (!pushSupported()) return { ok: true };
  const reg = await readyRegistration();
  if (!reg) return { ok: false, reason: "no_service_worker" };
  try {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await removePushSubscription(endpoint);
    }
  } catch (err) {
    return { ok: false, reason: "unsubscribe_failed", error: err?.message || String(err) };
  }
  return { ok: true };
}

// Local-only check: proves permission + service worker + notification display
// work on this device. It does NOT prove the server can deliver - that needs a
// real push from the jarvis function.
export async function showLocalTestNotification() {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (Notification.permission !== "granted") return { ok: false, reason: Notification.permission };
  const reg = await readyRegistration();
  if (!reg) return { ok: false, reason: "no_service_worker" };
  try {
    // Resolve assets off the registration scope, not the calling page - this is
    // callable from /pages/* and from the root.
    const icon = new URL("icons/icon-192.svg", reg.scope).href;
    await reg.showNotification("Trackerz", {
      body: "Local test - this device can show notifications.",
      icon,
      badge: icon,
      tag: "jarvis-test",
      data: { url: reg.scope },
    });
  } catch (err) {
    return { ok: false, reason: "show_failed", error: err?.message || String(err) };
  }
  return { ok: true };
}
