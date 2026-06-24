// PWA boot: registers the service worker and exposes an install hook.
// Call once per page after DOMContentLoaded.

import { drainOfflineQueue } from "./offline-queue.js";

let deferredPrompt = null;

function swPath() {
  // index.html lives at the repo root; everything else is one level deeper
  // under /pages/. Make the SW reachable from either.
  const path = globalThis.location?.pathname || "/";
  const inPagesDir = /\/pages\//.test(path);
  return inPagesDir ? "../sw.js" : "./sw.js";
}

function swScope() {
  const path = globalThis.location?.pathname || "/";
  const inPagesDir = /\/pages\//.test(path);
  return inPagesDir ? "../" : "./";
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(swPath(), { scope: swScope() });
    // Auto-apply new deploys: when a fresh SW takes control, reload once so the
    // user is never stuck on a ghost version.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      globalThis.location?.reload();
    });
    reg.update?.();
    return reg;
  } catch (err) {
    console.warn("sw register failed", err);
    return null;
  }
}

export function bindInstallPrompt(buttonId = "installAppBtn") {
  globalThis.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById(buttonId);
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        btn.hidden = true;
      });
    }
  });
}

export function bindOnlineDrain(runCapture) {
  const flush = () => drainOfflineQueue(runCapture).catch(() => null);
  globalThis.addEventListener("online", flush);
  if (navigator.onLine) flush();
}

export function isStandalone() {
  return globalThis.matchMedia?.("(display-mode: standalone)").matches
    || globalThis.navigator?.standalone === true;
}
