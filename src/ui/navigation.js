// Shared bottom navigation. Every page hosts `<nav id="bottomNav" class="bottom-nav">`
// and calls renderNav(activeId) once on boot. Path-aware so the same hrefs work
// from the site root (index.html) and from /pages/*. Replaces the old unused,
// scroll-spy nav that keyed off button text.

import { APP_VERSION } from "../version.js";

export const NAV_TABS = [
  { id: "home", label: "Home", href: "index.html" },
  { id: "money", label: "Money", href: "pages/money.html" },
  { id: "diet", label: "Diet", href: "pages/diet.html" },
  { id: "gym", label: "Gym", href: "pages/gym.html" },
  { id: "analytics", label: "Analytics", href: "pages/analytics.html" },
];

// Pure: build the nav markup. `base` is "./" from the root or "../" from /pages/.
export function navHtml(activeId, base = "./") {
  return NAV_TABS.map((t) =>
    `<a class="nav-item${t.id === activeId ? " active" : ""}" href="${base}${t.href}">${t.label}</a>`,
  ).join("");
}

export function renderNav(activeId) {
  stampVersion();
  const host = document.querySelector("#bottomNav");
  if (!host) return;
  const base = (globalThis.location?.pathname || "").includes("/pages/") ? "../" : "./";
  host.innerHTML = navHtml(activeId, base);
}

// Stamp the live build version on every page (top-right). Tap it to force a
// fresh load: unregister the service worker, clear all caches, then reload - so a
// stale browser cache can never trap you on an old version.
export function stampVersion() {
  if (typeof document === "undefined" || !document.body) return;
  let el = document.querySelector("#versionStamp");
  if (!el) {
    el = document.createElement("button");
    el.id = "versionStamp";
    el.type = "button";
    el.className = "version-stamp";
    el.title = "Live build - tap to force-update (clears cache + reloads)";
    el.addEventListener("click", forceFreshReload);
    document.body.appendChild(el);
  }
  el.textContent = APP_VERSION;
}

async function forceFreshReload(event) {
  const btn = event?.currentTarget;
  if (btn) btn.textContent = "updating…";
  try {
    if (globalThis.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* best effort */ }
  // Cache-bust the navigation so even the HTTP cache is bypassed.
  const url = new URL(globalThis.location.href);
  url.searchParams.set("_v", Date.now().toString());
  globalThis.location.replace(url.toString());
}
