import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navHtml, navMarkup, activeIdForPath, NAV_TABS } from "../src/ui/navigation.js";
import { NAV_PAGES, expectedNavFor } from "../scripts/build-nav.mjs";

// The six-tab bottom nav. Settings is a tab because it is where Health Connect
// and notifications live, and it was previously reachable only via a small gear.
assert.equal(NAV_TABS.length, 6);
assert.deepEqual(NAV_TABS.map((t) => t.id), ["home", "money", "diet", "gym", "analytics", "settings"]);

// From the site root, hrefs are "./…".
const root = navHtml("home", "./");
assert.ok(root.includes('href="./index.html"'), "root home href");
assert.ok(root.includes('href="./pages/money.html"'), "root money href");
assert.ok(root.includes('href="./pages/settings.html"'), "root settings href");
assert.ok(/class="nav-item active"[^>]*>Home</.test(root), "home is active at root");

// From a /pages/ page, "../" still resolves correctly (../ -> root, then pages/…).
const fromPages = navHtml("money", "../");
assert.ok(fromPages.includes('href="../index.html"'), "pages home href -> root");
assert.ok(fromPages.includes('href="../pages/money.html"'), "pages money href");
assert.ok(/class="nav-item active"[^>]*>Money</.test(fromPages), "money is active in pages");

// Exactly one active tab, and the active one carries aria-current.
assert.equal((fromPages.match(/nav-item active/g) || []).length, 1, "exactly one active");
assert.equal((fromPages.match(/aria-current="page"/g) || []).length, 1, "active tab marks aria-current");
assert.equal((navHtml(undefined, "./").match(/nav-item active/g) || []).length, 0, "no active when unset");

// An id that is not a tab leaves none active rather than throwing.
assert.equal((navHtml("diagnostics", "./").match(/nav-item active/g) || []).length, 0);

// ---- active tab derived from the URL -----------------------------------------
assert.equal(activeIdForPath("/trackerz/index.html"), "home");
assert.equal(activeIdForPath("/trackerz/pages/money.html"), "money");
assert.equal(activeIdForPath("/trackerz/pages/settings.html"), "settings");
assert.equal(activeIdForPath("/trackerz/pages/audit.html"), undefined, "audit is not a tab");

// ---- every page carries the tabs STATICALLY ----------------------------------
// This is the regression that stranded the owner: the nav was injected only from
// inside bootWithAuth's onReady callback, so on any page whose modules failed to
// import (pages/money.html still pulls XLSX from esm.sh) no bottom bar appeared
// at all. The tabs must be in the HTML, present with zero JS.
for (const page of NAV_PAGES) {
  const html = readFileSync(page.file, "utf8");
  const expected = expectedNavFor(page);
  assert.ok(
    html.includes(expected),
    `${page.file} bottom nav is missing or stale - run: node scripts/build-nav.mjs`,
  );
  // Every tab must actually be there, not just the container.
  for (const tab of NAV_TABS) {
    assert.ok(html.includes(`>${tab.label}</a>`), `${page.file} is missing the ${tab.label} tab`);
  }
}

// navMarkup wraps the links in the host element the CSS targets.
const markup = navMarkup("home", "./");
assert.ok(markup.startsWith('<nav id="bottomNav" class="bottom-nav"'), "nav host id + class");
assert.ok(markup.endsWith("</nav>"));

console.log(`navigation tests passed: ${NAV_TABS.length} tabs, static on ${NAV_PAGES.length} pages`);
