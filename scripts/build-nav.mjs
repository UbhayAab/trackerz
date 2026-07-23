// Stamps the bottom-nav tabs into every page's HTML from the one source of
// truth (NAV_TABS in src/ui/navigation.js).
//
// Why the tabs are static markup and not injected at runtime: the nav used to be
// rendered only from inside bootWithAuth's onReady callback, so it required auth
// to resolve AND the page's whole module graph to import before it appeared. Any
// page whose modules failed to load showed no bottom bar at all, stranding the
// user with no way to move between pages. Chrome you navigate with must not
// depend on data code succeeding.
//
// Run after changing NAV_TABS: node scripts/build-nav.mjs
// tests/navigation.test.mjs fails if a page drifts out of sync.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { navMarkup, activeIdForPath } from "../src/ui/navigation.js";

export const NAV_PAGES = [
  { file: "index.html", base: "./" },
  { file: "pages/money.html", base: "../" },
  { file: "pages/diet.html", base: "../" },
  { file: "pages/gym.html", base: "../" },
  { file: "pages/analytics.html", base: "../" },
  { file: "pages/settings.html", base: "../" },
  { file: "pages/diagnostics.html", base: "../" },
  { file: "pages/audit.html", base: "../" },
];

// Matches the whole <nav id="bottomNav" ...>...</nav> element, however it is
// currently written (self-closing content or not).
const NAV_RE = /<nav\s+id="bottomNav"[\s\S]*?<\/nav>/;

export function expectedNavFor(page) {
  return navMarkup(activeIdForPath(page.file), page.base);
}

function run() {
  let changed = 0;
  for (const page of NAV_PAGES) {
    const src = readFileSync(page.file, "utf8");
    if (!NAV_RE.test(src)) {
      console.error(`no #bottomNav element found in ${page.file} - skipped`);
      continue;
    }
    const next = src.replace(NAV_RE, expectedNavFor(page));
    if (next !== src) {
      writeFileSync(page.file, next, "utf8");
      changed += 1;
      console.log("stamped", page.file);
    }
  }
  console.log(changed ? `updated ${changed} page(s)` : "all pages already in sync");
}

// pathToFileURL, because a raw `file://${argv[1]}` never matches on Windows
// (drive letter + backslashes vs the three-slash file URL).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
