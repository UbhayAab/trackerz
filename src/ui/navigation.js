// Shared bottom navigation. Every page hosts `<nav id="bottomNav" class="bottom-nav">`
// and calls renderNav(activeId) once on boot. Path-aware so the same hrefs work
// from the site root (index.html) and from /pages/*. Replaces the old unused,
// scroll-spy nav that keyed off button text.

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
  const host = document.querySelector("#bottomNav");
  if (!host) return;
  const base = (globalThis.location?.pathname || "").includes("/pages/") ? "../" : "./";
  host.innerHTML = navHtml(activeId, base);
}
