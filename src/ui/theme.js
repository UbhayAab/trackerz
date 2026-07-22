// Theme controller - light / dark with a system default. The initial value is
// applied before first paint by a tiny inline script in each page <head> (no
// flash); this module keeps it in sync, mounts the topbar toggle, and reacts to
// OS changes while the user is on "system". Persisted in localStorage.

const KEY = "trackerz.theme"; // "light" | "dark" | "system"

const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;

function readPref() {
  try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; }
}
function systemDark() {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
}
export function resolveTheme(pref = readPref()) {
  return pref === "system" ? (systemDark() ? "dark" : "light") : pref;
}

export function applyTheme(theme = resolveTheme()) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#101412" : "#138a5b");
}

let toggleBtn = null;
function refreshToggle() {
  if (!toggleBtn) return;
  const t = resolveTheme();
  toggleBtn.innerHTML = t === "dark" ? ICON_SUN : ICON_MOON;
  const label = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
  toggleBtn.setAttribute("aria-label", label);
  toggleBtn.setAttribute("title", label);
}

function setPref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* private mode */ }
  applyTheme(resolveTheme(pref));
  refreshToggle();
}

function mountToggle() {
  const topbar = document.querySelector(".topbar");
  if (!topbar || topbar.querySelector(".theme-toggle")) return;

  toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "theme-toggle";
  toggleBtn.addEventListener("click", () => setPref(resolveTheme() === "dark" ? "light" : "dark"));

  // group the toggle with any existing right-side action (e.g. the Settings link)
  let actions = topbar.querySelector(".topbar-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "topbar-actions";
    const existing = topbar.querySelector(".icon-link");
    if (existing && existing.parentElement === topbar) actions.appendChild(existing);
    topbar.appendChild(actions);
  }
  actions.insertBefore(toggleBtn, actions.firstChild);
  refreshToggle();
}

export function initTheme() {
  applyTheme(); // safety: ensure attribute is set even if the inline script was blocked
  mountToggle();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (readPref() === "system") { applyTheme(); refreshToggle(); }
    });
  } catch { /* older browsers */ }
}
