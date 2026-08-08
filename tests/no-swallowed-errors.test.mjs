// NO SWALLOWED ERRORS - the build-failing guard against this repo's core disease.
//
// The disease, all verified in this codebase:
//   - The cross-source dedupe pipeline went dark for WEEKS because a thrown
//     exception and "scanned cleanly, found nothing" produced identical UI.
//   - 19 of 89 captures in one audit window wrote zero rows, with no error
//     anywhere on screen or in a log.
//   - The 14:30 cron slot returned HTTP 400 every day since it was written; the
//     workflow piped the body to `head` and exited 0, so CI stayed green.
//   - `request_user_review` rows have never been rendered in any surface since
//     the app was built. Every question the owner typed produced silence.
//   - period-aggregator emitted a measured `0` for a day with no rows, which
//     flowed into trend lines as "you ate nothing".
//
// Every one of those is the same line of code: a failure turned into a value
// that looks like data. This test finds that line and fails the build on any NEW
// one, while letting the existing ones be paid down one at a time.
//
// TWO HALVES
//
// 1. SYNTACTIC - scan src/ and lib/ for the shapes that swallow:
//      empty `catch {}` / `catch (e) {}`
//      `.catch(() => [])`, `=> {}`, `=> null`, `=> 0`
//      `if (error) return []`
//      `(count|total|sum|amount|value) || 0`
//    Every existing hit must be in tests/fixtures/swallow-allowlist.json with a
//    REASON. A missing reason fails. An allowlisted site that no longer exists
//    fails, so stale suppressions get deleted instead of accumulating. The total
//    is ratcheted against a BASELINE committed below: it can only go down.
//    ANY NEW EMPTY CATCH FAILS THE BUILD IMMEDIATELY.
//
// 2. SEMANTIC - a renderer with no error branch at all is the actual bug. For
//    every module in src/ui/ that imports a FETCHER from src/services/, require
//    it to reference at least one of renderError|degraded|result.ok|Err(|fmtMetric.
//    Same ratchet: the modules that do not yet are listed, with reasons, and the
//    list can only shrink.
//
// Comments and string literals are blanked before matching, so a comment that
// merely QUOTES `.catch(() => [])` (src/state/sync.js has one describing the bug
// it fixed) is not counted as a hit.
//
// Regenerating after an unrelated edit moves lines around:
//     node tests/no-swallowed-errors.test.mjs --seed
// That rewrites line/text for sites that still exist and KEEPS your reasons. It
// will not invent a reason for a new site - you have to write one, or fix it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Committed ratchets. These may be LOWERED (by fixing a site and deleting its
// entry) and never raised. Raising one is a code review conversation, not an
// edit.
// 92 -> 89 on 2026-08-08: the capture page's voice path lost three empty
// catches when it stopped hiding what Stop had done (two swallowed a
// recogniser/recorder stop failure, one swallowed a native listener teardown).
// 92 -> 89: three empty catches genuinely removed from the voice path.
// 89 -> 85: the four `.catch(() => {})` sites in src/pages/bootstrap.js, which
// this allowlist had already flagged as a REAL GAP and deferred ("auto-capture
// can silently never start and the Settings toggles still read as if it did").
// They are now startDeviceSync(), which records an Ok/Err per sync and reports
// it on the diagnostics page. The live data said the gap was not theoretical:
// passive spend capture has written one row in its life, and that row was a
// diagnostics self-test.
// 85 -> 83: two more went with the recorder that used to run alongside the
// speech recogniser on the Home capture box. Deleting the code that swallowed
// is the only reduction that is not a promise.
const SWALLOW_BASELINE = 83;
const RENDERER_BASELINE = 8;

const FIXTURE = "tests/fixtures/swallow-allowlist.json";
const SEED = process.argv.includes("--seed");

// --- the shapes that swallow --------------------------------------------------

const PATTERNS = [
  // `catch {}` and `catch (e) {}` with nothing in the body. The single worst
  // shape in the list: it turns any exception into "nothing happened".
  { id: "empty-catch", re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g },
  // A rejected promise defaulted into a value that reads as real data.
  { id: "catch-empty-array", re: /\.catch\s*\(\s*\(?\s*[\w$]*\s*\)?\s*=>\s*\[\s*\]\s*\)/g },
  { id: "catch-empty-obj", re: /\.catch\s*\(\s*\(?\s*[\w$]*\s*\)?\s*=>\s*\(?\{\s*\}\)?\s*\)/g },
  { id: "catch-null", re: /\.catch\s*\(\s*\(?\s*[\w$]*\s*\)?\s*=>\s*(?:null|undefined)\s*\)/g },
  { id: "catch-zero", re: /\.catch\s*\(\s*\(?\s*[\w$]*\s*\)?\s*=>\s*0\s*\)/g },
  // The Supabase shape: `const { data, error } = await ...; if (error) return [];`
  // The caller cannot tell that from an empty table.
  { id: "error-return-empty", re: /if\s*\(\s*[\w$.]*error[\w$.]*\s*\)\s*(?:\{\s*)?return\s*(?:\[\s*\]|null|\{\s*\}|0)\s*;/g },
  // Absent rendered as a measured zero. The exact bug in the analytics layer.
  { id: "absent-as-zero", re: /\b\w*(?:count|total|sum|amount|value)\w*\s*(?:\|\||\?\?)\s*0\b/gi },
];

// The only sanctioned defaulting helper. A site that routes through it is not a
// swallow: the failure is still a Result and still nameable by the banner.
const SANCTIONED = /unwrapOr\s*\(/;

/**
 * Blank comments, string bodies and template text, preserving byte offsets and
 * newlines so line numbers stay exact. Without this the scanner counts prose:
 * `src/ui/capture-panel.js` has a comment explaining a `catch {}` it removed,
 * and `src/state/sync.js` has one quoting `.catch(() => [])`.
 *
 * This is a real (small) lexer rather than a mode flag, because the naive
 * version silently UNDER-COUNTED. It read the `/` of a regex literal like
 * /['"]/ as the start of a string, ran off to the next apostrophe in the file,
 * and blanked everything between - which hid two live `.catch(() => {})` sites
 * in src/ui/gym-today.js. A scanner that quietly stops seeing things is the same
 * disease as the code it is scanning, so `clean` reports whether the lexer
 * finished in plain code and the caller FAILS the build when it did not.
 *
 * Handles: line/block comments, ' and " strings, template literals INCLUDING
 * nested ${...} expressions (which can contain further templates), and regex
 * literals (with [...] classes).
 */
function blankNonCode(src) {
  const out = new Array(src.length);
  const stack = [{ type: "code", braces: 0 }];
  let i = 0;
  let lastCode = ""; // last non-whitespace character emitted as code
  const top = () => stack[stack.length - 1];
  const keep = (n = 1) => { for (let k = 0; k < n; k++) out[i + k] = src[i + k]; i += n; };
  const blank = (n = 1) => { for (let k = 0; k < n; k++) out[i + k] = src[i + k] === "\n" ? "\n" : " "; i += n; };

  // A `/` starts a regex (not a division) only after one of these.
  const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);
  const KEYWORD_BEFORE_REGEX = /\b(return|typeof|case|in|of|do|else|yield|await|delete|void|instanceof)$/;

  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (top().type === "template") {
      if (c === "\\") { blank(2); continue; }
      if (c === "`") { stack.pop(); keep(); lastCode = "`"; continue; }
      if (c === "$" && c2 === "{") { stack.push({ type: "code", braces: 0 }); keep(2); lastCode = "{"; continue; }
      blank();
      continue;
    }
    if (c === "/" && c2 === "/") { while (i < src.length && src[i] !== "\n") blank(); continue; }
    if (c === "/" && c2 === "*") {
      blank(2);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank();
      if (i < src.length) blank(2);
      continue;
    }
    if (c === '"' || c === "'") {
      keep();
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") { blank(2); continue; }
        if (src[i] === "\n") break; // unterminated: do not run off the end of the file
        blank();
      }
      if (i < src.length && src[i] === c) keep();
      lastCode = c;
      continue;
    }
    if (c === "`") { stack.push({ type: "template" }); keep(); continue; }
    if (c === "/" && (REGEX_PRECEDERS.has(lastCode) || KEYWORD_BEFORE_REGEX.test(src.slice(Math.max(0, i - 24), i).trimEnd()))) {
      keep();
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") { blank(2); continue; }
        if (d === "\n") break; // unterminated: it was division after all
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { keep(); break; }
        blank();
      }
      lastCode = "/";
      continue;
    }
    if (c === "{") { top().braces += 1; keep(); lastCode = "{"; continue; }
    if (c === "}") {
      if (top().braces > 0) top().braces -= 1;
      else if (stack.length > 1) stack.pop();
      keep();
      lastCode = "}";
      continue;
    }
    if (!/\s/.test(c)) lastCode = c;
    keep();
  }
  return { code: out.join(""), clean: stack.length === 1 && stack[0].type === "code" };
}

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) jsFiles(rel, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(rel.replaceAll("\\", "/"));
  }
  return out;
}

function scan() {
  const hits = [];
  const unlexable = [];
  for (const file of [...jsFiles("src"), ...jsFiles("lib")]) {
    const raw = readFileSync(file, "utf8");
    const { code, clean } = blankNonCode(raw);
    // A scanner that silently stops seeing part of a file is worse than no
    // scanner: it reports "0 new swallow sites" over code it never looked at.
    if (!clean) unlexable.push(file);
    const rawLines = raw.split("\n");
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(code)) !== null) {
        const line = code.slice(0, m.index).split("\n").length;
        const text = (rawLines[line - 1] || "").trim();
        if (SANCTIONED.test(text)) continue; // unwrapOr() is the sanctioned default
        hits.push({ file, pattern: pattern.id, line, text: text.slice(0, 160) });
      }
    }
  }
  hits.sort((a, b) => (a.file === b.file
    ? (a.line === b.line ? a.pattern.localeCompare(b.pattern) : a.line - b.line)
    : a.file.localeCompare(b.file)));
  assert.equal(
    unlexable.length,
    0,
    `the swallow scanner could not lex these files, so it did NOT scan them - fix the lexer before trusting a green run:\n  ${unlexable.join("\n  ")}`,
  );
  return hits;
}

// --- semantic half: renderers with no error branch ----------------------------

// A "fetcher" is an imported name that goes and gets data. Importing signOut or
// showToast from src/services/ says nothing about whether this module renders
// numbers that can fail to load; importing fetchLedger says everything.
const FETCHER_NAME = /^(fetch|load|list|read|query|get[A-Z].*(?:Data|Rows|Logs|State|Profile|Estimate))/;
const ERROR_BRANCH = /renderError|degraded|result\.ok|Err\(|fmtMetric/;

function importedServiceNames(src) {
  const names = [];
  const re = /import\s+([\s\S]*?)\s+from\s+["'](\.\.\/services\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1];
    // A default or namespace import (`import x from`, `import * as x from`)
    // hides the member names, so treat the whole module as a possible fetcher.
    if (!clause.includes("{")) { names.push("*"); continue; }
    for (const raw of clause.slice(clause.indexOf("{") + 1, clause.lastIndexOf("}")).split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function renderersWithoutErrorBranch() {
  const bare = [];
  for (const file of jsFiles("src/ui")) {
    const raw = readFileSync(file, "utf8");
    const names = importedServiceNames(raw);
    if (!names.some((n) => n === "*" || FETCHER_NAME.test(n))) continue;
    if (ERROR_BRANCH.test(blankNonCode(raw).code)) continue;
    bare.push(file);
  }
  return bare.sort();
}

// --- seed / regenerate --------------------------------------------------------

function loadFixture() {
  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.ok(Array.isArray(parsed.entries), `${FIXTURE} must have an "entries" array`);
  assert.ok(Array.isArray(parsed.renderersWithoutErrorBranch), `${FIXTURE} must have a "renderersWithoutErrorBranch" array`);
  return parsed;
}

if (SEED) {
  let previous = { entries: [], renderersWithoutErrorBranch: [] };
  try { previous = loadFixture(); } catch { previous = { entries: [], renderersWithoutErrorBranch: [] }; }
  const reasonFor = new Map(previous.entries.map((e) => [`${e.file}::${e.pattern}`, e.reason]));
  const rendererReason = new Map(previous.renderersWithoutErrorBranch.map((e) => [e.file, e.reason]));
  const next = {
    _: "Generated by `node tests/no-swallowed-errors.test.mjs --seed`. Reasons are hand-written and preserved across regenerations; line/text are refreshed. Delete an entry when you fix the site - the baselines in the test only ratchet down.",
    entries: scan().map((h) => ({ ...h, reason: reasonFor.get(`${h.file}::${h.pattern}`) || "REASON REQUIRED" })),
    renderersWithoutErrorBranch: renderersWithoutErrorBranch().map((file) => ({
      file,
      reason: rendererReason.get(file) || "REASON REQUIRED",
    })),
  };
  writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
  const todo = next.entries.filter((e) => e.reason === "REASON REQUIRED").length
    + next.renderersWithoutErrorBranch.filter((e) => e.reason === "REASON REQUIRED").length;
  console.log(`seeded ${FIXTURE}: ${next.entries.length} swallow sites, ${next.renderersWithoutErrorBranch.length} bare renderers, ${todo} awaiting a reason`);
  process.exit(0);
}

// --- assertions ---------------------------------------------------------------

const allowlist = loadFixture();
const entries = allowlist.entries;
const hits = scan();

// 1. Every entry carries a real reason. "A missing reason fails" is the whole
//    point of the allowlist: an unexplained suppression is indistinguishable
//    from the bug it is hiding.
for (const e of entries) {
  assert.ok(e.file && e.pattern, `allowlist entry missing file/pattern: ${JSON.stringify(e)}`);
  assert.ok(
    typeof e.reason === "string" && e.reason.trim().length >= 20 && !/^(todo|tbd|reason required|n\/a|ignore)/i.test(e.reason.trim()),
    `allowlist entry ${e.file}:${e.line} (${e.pattern}) has no usable reason - say why this swallow is correct, or fix it`,
  );
}

// 2. The ratchet. Fixing a site and deleting its entry lowers this; nothing
//    raises it without editing the constant above in a reviewed change.
assert.ok(
  entries.length <= SWALLOW_BASELINE,
  `swallow allowlist grew to ${entries.length} (baseline ${SWALLOW_BASELINE}). The count only goes down.`,
);

// 3. Match hits against entries per (file, pattern). Matching by GROUP rather
//    than by exact line on purpose: an unrelated edit two functions up shifts
//    every line below it, and a guard that fails on that is a guard people
//    disable. The recorded line/text stay in the fixture as the human pointer
//    and are refreshed by --seed.
const key = (x) => `${x.file}::${x.pattern}`;
const groupOf = (xs) => xs.reduce((acc, x) => { (acc[key(x)] ||= []).push(x); return acc; }, {});
const hitGroups = groupOf(hits);
const entryGroups = groupOf(entries);

const newSites = [];
const staleEntries = [];
for (const k of new Set([...Object.keys(hitGroups), ...Object.keys(entryGroups)])) {
  const found = hitGroups[k] || [];
  const allowed = entryGroups[k] || [];
  if (found.length > allowed.length) {
    newSites.push(...found.slice(allowed.length).map((h) => ({ ...h, allowedCount: allowed.length, foundCount: found.length })));
  } else if (allowed.length > found.length) {
    staleEntries.push(...allowed.slice(found.length));
  }
}

// 4. ANY NEW EMPTY CATCH FAILS IMMEDIATELY - reported first and on its own, so
//    the message is not buried under an amount-defaulting diff.
const newEmptyCatches = newSites.filter((h) => h.pattern === "empty-catch");
assert.equal(
  newEmptyCatches.length,
  0,
  `NEW EMPTY CATCH BLOCK(S). An empty catch turns any exception into "nothing happened" - the single shape behind every silent-failure incident in this repo. Handle the error, surface it via lib/failure.mjs, or (if the swallow is genuinely correct) add it to ${FIXTURE} with a reason:\n`
  + newEmptyCatches.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n"),
);

assert.equal(
  newSites.length,
  0,
  `NEW SWALLOWED-ERROR SITE(S). Route the failure through lib/failure.mjs (Ok/Err/unwrapOr) so it can be surfaced, or allowlist it in ${FIXTURE} with a reason:\n`
  + newSites.map((h) => `  [${h.pattern}] ${h.file}:${h.line}  ${h.text}`).join("\n"),
);

// 5. Stale suppressions must be deleted, not left to rot. A suppression for code
//    that no longer exists is how an allowlist quietly stops describing reality.
assert.equal(
  staleEntries.length,
  0,
  `STALE ALLOWLIST ENTRIES - these sites no longer exist. Delete them from ${FIXTURE} (and lower the baseline if you can):\n`
  + staleEntries.map((e) => `  [${e.pattern}] ${e.file}:${e.line}  ${e.text || ""}`).join("\n"),
);

// 6. Semantic half. A UI module that fetches and renders but has no error branch
//    anywhere in it cannot show the user that a number is missing rather than
//    zero - it is structurally incapable of being honest.
const bare = renderersWithoutErrorBranch();
const bareAllowed = new Set(allowlist.renderersWithoutErrorBranch.map((e) => e.file));
for (const e of allowlist.renderersWithoutErrorBranch) {
  assert.ok(
    typeof e.reason === "string" && e.reason.trim().length >= 20 && !/^(todo|tbd|reason required)/i.test(e.reason.trim()),
    `renderer allowlist entry ${e.file} has no usable reason`,
  );
}
const newBare = bare.filter((f) => !bareAllowed.has(f));
assert.equal(
  newBare.length,
  0,
  "UI module(s) that read from src/services/ with NO error branch at all "
  + `(none of renderError|degraded|result.ok|Err(|fmtMetric). Render a "-" via fmtMetric or a named failure via src/ui/degraded-banner.js:\n`
  + newBare.map((f) => `  ${f}`).join("\n"),
);
const fixedBare = [...bareAllowed].filter((f) => !bare.includes(f));
assert.equal(
  fixedBare.length,
  0,
  `These renderers now HAVE an error branch - delete them from renderersWithoutErrorBranch in ${FIXTURE} and lower RENDERER_BASELINE:\n`
  + fixedBare.map((f) => `  ${f}`).join("\n"),
);
assert.ok(
  allowlist.renderersWithoutErrorBranch.length <= RENDERER_BASELINE,
  `renderer allowlist grew to ${allowlist.renderersWithoutErrorBranch.length} (baseline ${RENDERER_BASELINE}). The count only goes down.`,
);

const byPattern = entries.reduce((acc, e) => { acc[e.pattern] = (acc[e.pattern] || 0) + 1; return acc; }, {});
console.log(
  `no-swallowed-errors tests passed: ${hits.length} known swallow sites (${Object.entries(byPattern).map(([k, v]) => `${k} ${v}`).join(", ")}), `
  + `${allowlist.renderersWithoutErrorBranch.length} renderers without an error branch, both ratcheted`,
);
