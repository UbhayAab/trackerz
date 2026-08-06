// LAYOUT CONTRACT - the CSS rules that stop the app being wider than the phone.
//
// The owner reported the capture box "stretched across outside the screen" while
// scripts/smoke-ui.mjs was reporting `horizontalOverflow: false`. The check was
// not unlucky: styles/theme-premium.css puts `overflow-x: hidden` on the root,
// root overflow propagates to the viewport, and a clipped viewport clamps
// documentElement.scrollWidth to clientWidth - so that one-liner could never
// say true, whatever the page actually laid out at. Measured on
// pages/diagnostics.html at 320px it read 320 while the content was 390.
//
// The browser sweep now measures with that clip switched off (see smoke-ui), but
// it needs a browser and a live session. This file is the part that runs in the
// npm test chain with neither: it asserts the specific declarations that make
// the layout safe, so nobody can quietly delete one and rely on the clip to hide
// what happens next.
//
// Run: node tests/layout-contract.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const cssFiles = readdirSync("styles").filter((f) => f.endsWith(".css"));
const css = Object.fromEntries(cssFiles.map((f) => [f, readFileSync(join("styles", f), "utf8")]));
const allCss = Object.values(css).join("\n");

// Strip comments before matching, so the prose explaining a rule can never be
// mistaken for the rule. This file has a lot of prose.
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const bare = Object.fromEntries(Object.entries(css).map(([f, t]) => [f, strip(t)]));
const allBare = Object.values(bare).join("\n");

// Pull one rule block out by selector. Good enough for a hand-written stylesheet
// with no nesting, which is what this repo has.
function ruleBody(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(text);
  return m ? m[2] : null;
}

// ---------------------------------------------------------------------------
// 1. The capture textarea has an explicit width bound and no cols layout.
//
// A <textarea> is sized from its `cols` attribute (default 20) and will NOT
// shrink below that on its own. It is also a grid item, whose automatic minimum
// size is its min-content contribution - the same cols-derived width. Both have
// to be answered explicitly; relying on the panel's width being definite is how
// a refactor two files away turns into an input wider than the phone.
// ---------------------------------------------------------------------------
{
  const body = ruleBody(bare["capture.css"], "#captureText");
  assert.ok(body, "styles/capture.css must still define a #captureText rule");
  for (const decl of [
    ["width", /(^|;)\s*width:\s*100%/],
    ["max-width", /(^|;)\s*max-width:\s*100%/],
    ["min-width", /(^|;)\s*min-width:\s*0/],
    ["box-sizing", /(^|;)\s*box-sizing:\s*border-box/],
    // A pasted order link has no spaces in it. `break-word` (which is all the
    // browser's own stylesheet gives a textarea) wraps the line but does NOT
    // reduce min-content, so it does not stop the box being sized by that word.
    // `anywhere` does both. Measured at 320px with the wrap gone: the field's
    // scrollWidth is 613px inside a 264px content box.
    ["overflow-wrap", /(^|;)\s*overflow-wrap:\s*anywhere/],
  ]) {
    assert.match(body, decl[1], `#captureText must declare ${decl[0]} - see the comment above the rule`);
  }
}

// The markup must not reintroduce a fixed intrinsic width.
{
  const html = readFileSync("index.html", "utf8");
  const tag = /<textarea[\s\S]*?id="captureText"[\s\S]*?>/.exec(html);
  assert.ok(tag, "index.html must still contain the #captureText textarea");
  assert.ok(!/\bcols\s*=/.test(tag[0]), "#captureText must not carry a cols attribute - it is a fixed intrinsic width");
  assert.ok(!/style\s*=\s*"[^"]*width/.test(tag[0]), "#captureText must not carry an inline width");
}

// ---------------------------------------------------------------------------
// 2. The panel that holds it is a shrinkable track.
//
// A grid column written `1fr` is `minmax(auto, 1fr)`, and `auto` as a MINIMUM
// means "at least the widest child's min-content". One unbreakable string in any
// child then widens the whole panel. minmax(0, 1fr) is the same column, allowed
// to be narrow.
// ---------------------------------------------------------------------------
{
  const panel = ruleBody(bare["capture.css"], ".capture-panel");
  assert.ok(panel, "styles/capture.css must still define .capture-panel");
  assert.match(panel, /grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
    ".capture-panel must name a minmax(0, 1fr) track, not leave it implicit");
}

// Every grid that lays out a row of labelled controls, at any width. A bare
// `1fr` in one of these is the same bug wearing a different selector: measured
// on Home at 320px with a larger system font, `.command-grid { 1fr }` floored
// .command-panel at 313px inside a 300px shell.
for (const [file, selector] of [
  ["capture.css", ".capture-actions"],
  ["capture.css", ".capture-actions-big"],
]) {
  const body = ruleBody(bare[file], selector);
  assert.ok(body, `styles/${file} must still define ${selector}`);
  const cols = /grid-template-columns:([^;]*)/.exec(body);
  assert.ok(cols, `${selector} must declare grid-template-columns`);
  const withoutMinmax = cols[1].replace(/minmax\([^)]*\)/g, "");
  assert.ok(!/\d*\.?\d+fr/.test(withoutMinmax),
    `${selector} has a bare fr track (${cols[1].trim()}) - wrap it in minmax(0, ...) so the buttons can shrink`);
}

// responsive.css is where the phone widths are decided, so no bare fr may
// survive there at all.
{
  const cols = [...bare["responsive.css"].matchAll(/grid-template-columns:([^;]*)/g)];
  assert.ok(cols.length >= 3, "styles/responsive.css should still be setting the phone grid tracks");
  for (const m of cols) {
    const withoutMinmax = m[1].replace(/minmax\([^)]*\)/g, "");
    assert.ok(!/\d*\.?\d+fr/.test(withoutMinmax),
      `styles/responsive.css has a bare fr track (${m[1].trim()}) - use minmax(0, 1fr)`);
  }
}

// ---------------------------------------------------------------------------
// 3. Flex children that hold text can shrink.
//
// A flex item's default `min-width: auto` is its min-content width, so a run of
// text refuses to get narrower than its longest word and pushes the row instead.
// These are the four rows that were measured doing it.
// ---------------------------------------------------------------------------
for (const [file, selector, why] of [
  ["quick-actions.css", ".quick-note", "the sleep/water/gym note ran off the right edge of a 320px phone"],
  ["components.css", ".diag-row > *", "diagnostics rows laid out at 363px inside a 266px panel"],
]) {
  const body = ruleBody(bare[file], selector);
  assert.ok(body, `styles/${file} must still define ${selector}`);
  assert.match(body, /min-width:\s*0/, `${selector} needs min-width: 0 - ${why}`);
}

// The note must also be allowed to shrink by the flex algorithm, not just be
// permitted to. `flex: 0 0 auto` is what it used to say, and that is a refusal.
{
  const note = ruleBody(bare["quick-actions.css"], ".quick-note");
  assert.ok(!/flex:\s*0\s+0\s/.test(note), ".quick-note must not be flex: 0 0 auto - that is what pushed the row off-screen");
  assert.match(note, /flex:\s*1\s+1\s/, ".quick-note must be allowed to grow and shrink");
}

// Rows of controls wrap rather than run off the screen. `overflow-x: auto` on
// .quick-row hid the problem behind a swipe with no affordance.
{
  const row = ruleBody(bare["quick-actions.css"], ".quick-row");
  assert.ok(row, "styles/quick-actions.css must still define .quick-row");
  assert.match(row, /flex-wrap:\s*wrap/, ".quick-row must wrap");
  assert.ok(!/overflow-x:\s*(auto|scroll)/.test(row), ".quick-row must not scroll sideways - the note wraps instead");
}

// The topbar's runtime-injected actions (theme toggle, account chip) are a span
// on some pages and a div on others; only one of those used to be covered.
{
  assert.match(allBare, /\.topbar\s*>\s*\*\s*\{[^}]*min-width:\s*0/,
    "theme-premium.css must let every topbar child shrink (.topbar > *, not > div)");
}

// ---------------------------------------------------------------------------
// 4. The clip is a net, and must stay labelled as one.
//
// If someone deletes the explanation, the next person to read
// `html, body { overflow-x: hidden }` will believe the overflow question is
// answered. It is not: that line is why the smoke test could report green over
// 70px of clipped page.
// ---------------------------------------------------------------------------
{
  const theme = css["theme-premium.css"];
  assert.match(theme, /html,\s*body\s*\{[^}]*overflow-x:\s*hidden/, "the layout-safety net should still exist");
  const netIndex = theme.indexOf("html, body { max-width: 100%; overflow-x: hidden; }");
  assert.ok(netIndex > 0, "expected the layout-safety net on its own line in theme-premium.css");
  const preamble = theme.slice(Math.max(0, netIndex - 1400), netIndex);
  assert.match(preamble, /scrollWidth/,
    "the overflow-x net must keep the comment explaining that it clamps documentElement.scrollWidth");
  assert.match(preamble, /smoke-ui/,
    "the net's comment must point at the check that measures past it");
}

// The one thing the fix must NOT be: a new blanket clip somewhere else.
{
  const shells = [...allBare.matchAll(/([^{}]*)\{([^}]*overflow-x:\s*(hidden|clip)[^}]*)\}/g)]
    .map((m) => m[1].trim().replace(/\s+/g, " "))
    .filter((sel) => !/^@/.test(sel));
  const allowed = new Set([
    "html, body",
    ".app-shell, .page-shell",
    // One SVG chart that scales itself; the clip is a 1px anti-spill guard on a
    // box whose contents are already bounded, not a way of hiding a wide child.
    "#moneyInsights .mi-chart-wrap",
  ]);
  for (const sel of shells) {
    assert.ok(allowed.has(sel),
      `new blanket horizontal clip on "${sel}" - clipping hides overflow instead of fixing it, and blinds the smoke check. Add it to the allow-list here only with a measurement saying why.`);
  }
}

// ---------------------------------------------------------------------------
// 5. Safe-area insets, because four pages ship viewport-fit=cover.
//
// With viewport-fit=cover the layout viewport runs under a notch/cutout, which
// is what the Capacitor WebView hands us. Without max(..., env(...)) on the
// shell's inline padding, the first 30-40px of every row sits beneath it in
// landscape.
// ---------------------------------------------------------------------------
{
  const shell = ruleBody(bare["layout.css"], ".app-shell");
  assert.ok(shell, "styles/layout.css must still define .app-shell");
  assert.match(shell, /padding-inline:[^;]*env\(safe-area-inset-left/, ".app-shell inline padding must respect the left safe-area inset");
  assert.match(shell, /padding-inline:[^;]*env\(safe-area-inset-right/, ".app-shell inline padding must respect the right safe-area inset");
}

// Every page gets the same viewport, or the APK renders them at different
// widths for no reason anyone can see.
{
  const pages = ["index.html", "quick-log.html", "share-target.html",
    ...readdirSync("pages").filter((f) => f.endsWith(".html")).map((f) => join("pages", f))];
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    const m = /<meta name="viewport" content="([^"]*)"/.exec(html);
    assert.ok(m, `${file} must declare a viewport meta`);
    assert.match(m[1], /width=device-width/, `${file} viewport must be width=device-width`);
    assert.match(m[1], /viewport-fit=cover/, `${file} viewport must match the rest of the app (viewport-fit=cover)`);
    assert.ok(!/user-scalable=no|maximum-scale/.test(m[1]), `${file} must not block pinch zoom`);
  }
}

console.log("layout contract tests passed");
