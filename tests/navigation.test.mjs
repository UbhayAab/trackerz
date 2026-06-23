import assert from "node:assert/strict";
import { navHtml, NAV_TABS } from "../src/ui/navigation.js";

// The five-tab bottom nav.
assert.equal(NAV_TABS.length, 5);
assert.deepEqual(NAV_TABS.map((t) => t.id), ["home", "money", "diet", "gym", "analytics"]);

// From the site root, hrefs are "./…".
const root = navHtml("home", "./");
assert.ok(root.includes('href="./index.html"'), "root home href");
assert.ok(root.includes('href="./pages/money.html"'), "root money href");
assert.ok(/class="nav-item active"[^>]*>Home</.test(root), "home is active at root");

// From a /pages/ page, "../" still resolves correctly (../ -> root, then pages/…).
const fromPages = navHtml("money", "../");
assert.ok(fromPages.includes('href="../index.html"'), "pages home href -> root");
assert.ok(fromPages.includes('href="../pages/money.html"'), "pages money href");
assert.ok(/class="nav-item active"[^>]*>Money</.test(fromPages), "money is active in pages");

// Exactly one active tab; an id that isn't a tab (e.g. settings) leaves none active.
assert.equal((fromPages.match(/nav-item active/g) || []).length, 1, "exactly one active");
assert.equal((navHtml("settings", "./").match(/nav-item active/g) || []).length, 0, "settings -> no active tab");
assert.equal((navHtml(undefined, "./").match(/nav-item active/g) || []).length, 0, "no active when unset");

console.log("navigation tests passed");
