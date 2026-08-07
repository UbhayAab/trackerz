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
// Five tabs. There was a sixth, Diet, and it was the same screen as Home: both
// mounted #quickActions, #mealChips, #dietPlan and #insightList from the same
// modules, so the day plan, the water/gym/sleep row and the repeat-a-meal chips
// rendered identically on each. Home is the capture entry point and the PWA
// start_url, so Diet is the one that went; its two genuinely distinct panels
// moved to where they belong (macro intelligence -> Stats, calorie and protein
// targets -> Settings, next to every other budget).
export const NAV_TABS = [
  { id: "home", label: "Home", href: "index.html" },
  { id: "money", label: "Money", href: "pages/money.html" },
  { id: "gym", label: "Gym", href: "pages/gym.html" },
  // "Stats" not "Analytics": the tabs have to fit a 320px phone without wrapping.
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
//
// APP_VERSION is a hand-typed string and it read "v17" while CI was publishing
// build 45, so on the phone this badge was a constant, not a version. A constant
// cannot tell you whether an update landed: tapping "force refresh" and seeing
// "v17" again looks exactly like a failed update. Inside the APK the badge now
// shows the real bundled build number, which changes by construction.
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

// THE UPDATE THE PHONE NEVER HEARD ABOUT.
//
// The APK bundles the web app, so a fix on main is not a fix on the phone until
// a new APK is installed. Between builds 34 and 45 that never happened and
// nothing anywhere said so, which is how eleven builds of fixes were reported as
// still broken. This banner is the missing sentence.
//
// Everything here is best-effort and additive: no network failure, no missing
// module and no storage error may take the nav down with it.
const UPDATE_BANNER_ID = "updateBanner";

// Readable from the diagnostics page; the last thing that stopped the banner.
let updateBannerFailure = null;
export function updateBannerLastFailure() { return updateBannerFailure; }

export async function announceUpdate() {
  if (typeof document === "undefined" || !document.body) return;
  try {
    const [{ checkForUpdate }, { versionLabel, FLOATING_APK_URL }] = await Promise.all([
      import("../services/build-info.js"),
      import("../../lib/update-check.mjs"),
    ]);
    const { buildInfo, decision, latest, latestRes } = await checkForUpdate();

    // Honest badge first - it is useful even when the update check itself fails.
    const stamp = document.querySelector("#versionStamp");
    if (stamp && buildInfo) stamp.textContent = versionLabel({ buildInfo, fallback: APP_VERSION });

    // "current" and "not-applicable" are the quiet states. "unknown-*" is NOT
    // reassurance and must still be shown: an APK we cannot identify is exactly
    // the case that stranded him for six weeks.
    if (decision.state === "current" || decision.state === "not-applicable") {
      removeUpdateBanner();
      return;
    }
    // Name the failing source when the check itself failed, so "could not ask"
    // never reads like "asked, and you are fine".
    const why = latestRes && latestRes.ok === false ? ` (${latestRes.kind})` : "";
    renderUpdateBanner({
      message: `${decision.message}${why}`,
      href: latest?.url || FLOATING_APK_URL,
      versionName: latest?.versionName || "",
    });
  } catch (e) {
    // A broken update check must never be worse than no update check - but it
    // must not be invisible either, or this module joins the disease it fixes.
    updateBannerFailure = e;
    console.warn("update check failed", e);
  }
}

function removeUpdateBanner() {
  document.querySelector(`#${UPDATE_BANNER_ID}`)?.remove();
}

function renderUpdateBanner({ message, href, versionName }) {
  let el = document.querySelector(`#${UPDATE_BANNER_ID}`);
  if (!el) {
    el = document.createElement("div");
    el.id = UPDATE_BANNER_ID;
    el.className = "update-banner";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  const label = versionName ? `Install ${versionName}` : "Install the newest build";
  el.innerHTML = `
    <span class="update-banner-text">${message}</span>
    <a class="update-banner-cta" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>
    <button class="update-banner-dismiss" type="button" aria-label="Dismiss">&times;</button>`;
  el.querySelector(".update-banner-dismiss")?.addEventListener("click", removeUpdateBanner);
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

// THE BADGE AND THE UPDATE BANNER MUST NOT WAIT FOR AUTH.
//
// Every page calls renderNav() from inside bootWithAuth's callback, so anything
// renderNav does is gated on a session resolving. That was already the documented
// reason the nav TABS are static HTML rather than injected - "Chrome you navigate
// with must not depend on data code succeeding" - and the same argument applies
// twice over here: an app old enough to fail at signing in is precisely the app
// that most needs to be told it is eleven builds behind. Verified in a headless
// browser: gated behind bootWithAuth, the banner never appeared at all.
//
// So this runs on module load, which is immediate - the page's entry module
// imports this file before it does anything else. Guarded for Node, where
// tests/navigation.test.mjs imports this module with no DOM.
if (typeof document !== "undefined") {
  const paintChrome = () => {
    stampVersion();
    // Fire and forget: nothing on screen may wait on the network.
    void announceUpdate();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", paintChrome, { once: true });
  } else {
    paintChrome();
  }
}
