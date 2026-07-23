// Shared bottom navigation. Every page hosts `<nav id="bottomNav" class="bottom-nav">`
// and calls renderNav(activeId) once on boot. Path-aware so the same hrefs work
// from the site root (index.html) and from /pages/*. Replaces the old unused,
// scroll-spy nav that keyed off button text.

import { APP_VERSION } from "../version.js";

// The tabs are written STATICALLY into every page's HTML (scripts/build-nav.mjs
// stamps navMarkup below into each file). That is deliberate: the nav used to be
// injected only from inside bootWithAuth's onReady callback, so it needed auth to
// resolve AND the page's entire module graph to import before it appeared. On any
// page where a module failed to load - pages/money.html still pulls XLSX from
// esm.sh at import time - the bottom bar simply never showed up. Chrome you
// navigate with must not depend on data code succeeding.
export const NAV_TABS = [
  { id: "home", label: "Home", href: "index.html" },
  { id: "money", label: "Money", href: "pages/money.html" },
  { id: "diet", label: "Diet", href: "pages/diet.html" },
  { id: "gym", label: "Gym", href: "pages/gym.html" },
  // "Stats" not "Analytics": six tabs have to fit a 320px phone without wrapping.
  { id: "analytics", label: "Stats", href: "pages/analytics.html" },
  { id: "settings", label: "Settings", href: "pages/settings.html" },
];

// Pure: build the nav markup. `base` is "./" from the root or "../" from /pages/.
export function navHtml(activeId, base = "./") {
  return NAV_TABS.map((t) =>
    `<a class="nav-item${t.id === activeId ? " active" : ""}" href="${base}${t.href}"${t.id === activeId ? ' aria-current="page"' : ""}>${t.label}</a>`,
  ).join("");
}

// The whole <nav> element, for stamping into a page's HTML.
export function navMarkup(activeId, base = "./") {
  return `<nav id="bottomNav" class="bottom-nav" aria-label="Main navigation">${navHtml(activeId, base)}</nav>`;
}

// Which tab does this URL belong to? Lets the highlight stay correct even when a
// page forgets to say, and keeps copy-pasted static markup honest.
export function activeIdForPath(pathname = "") {
  const file = String(pathname).split("/").pop() || "index.html";
  const name = file || "index.html";
  const match = NAV_TABS.find((t) => t.href.endsWith(name));
  return match ? match.id : undefined;
}

export function renderNav(activeId) {
  stampVersion();
  const host = document.querySelector("#bottomNav");
  if (!host) return;
  const path = globalThis.location?.pathname || "";
  const base = path.includes("/pages/") ? "../" : "./";
  const active = activeId || activeIdForPath(path);
  const activeHref = NAV_TABS.find((t) => t.id === active)?.href;

  const links = host.querySelectorAll("a.nav-item");
  if (!links.length) {
    // No static markup here (an older page, or it was edited out). Inject rather
    // than leave the user with no way to move between pages.
    host.innerHTML = navHtml(active, base);
    return;
  }
  // The tabs already exist in the HTML: only move the highlight.
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const isActive = Boolean(activeHref) && href.endsWith(activeHref);
    a.classList.toggle("active", isActive);
    if (isActive) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
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
