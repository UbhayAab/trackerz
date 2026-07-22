// PWA boot: registers the service worker and exposes an install hook.
// Call once per page after DOMContentLoaded.

import { drainOfflineQueue } from "./offline-queue.js";
import { showToast } from "../ui/toast.js";

let deferredPrompt = null;
let installBound = false;
let registration = null;

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

// Memoised: several callers (page boot, push subscription) ask for the worker
// on the same page load, and each raw register() would add another
// controllerchange listener and another reload.
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  if (registration) return registration;
  registration = (async () => {
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
      registration = null; // allow a retry rather than caching the failure
      return null;
    }
  })();
  return registration;
}

// Chrome only lets us call prompt() later if we cancel its default mini-infobar,
// so cancelling means we owe the user a button. The old version only wired one
// when the page already had #installAppBtn - no page has one, so installing was
// suppressed everywhere and never offered again. Create the affordance if the
// page doesn't provide it.
export function bindInstallPrompt(buttonId = "installAppBtn") {
  if (installBound) return;
  installBound = true;

  globalThis.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (isStandalone()) return; // already installed; nothing to offer
    const btn = installButton(buttonId);
    btn.hidden = false;
    if (btn.dataset.installBound === "1") return;
    btn.dataset.installBound = "1";
    btn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      try {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        // A prompt is single-use either way; leaving a dead button on screen
        // would be the same lie as before.
        btn.hidden = true;
        if (choice?.outcome !== "accepted") {
          showToast("Install dismissed - you can still install from the browser menu.");
        }
      } catch (err) {
        showToast(`Install failed: ${err?.message || err}`, { kind: "error" });
      } finally {
        deferredPrompt = null;
      }
    });
  });

  globalThis.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    const btn = document.getElementById(buttonId);
    if (btn) btn.hidden = true;
  });
}

// Page-owned button if there is one, otherwise a floating chip above the nav.
function installButton(buttonId) {
  const existing = document.getElementById(buttonId);
  if (existing) return existing;
  const btn = document.createElement("button");
  btn.id = buttonId;
  btn.type = "button";
  btn.className = "secondary-button";
  btn.textContent = "Install app";
  btn.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);" +
    "bottom:calc(86px + env(safe-area-inset-bottom, 0px));z-index:55;";
  document.body.appendChild(btn);
  return btn;
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
