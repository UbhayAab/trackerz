// Guards the "dead HTML shell when esm.sh is down" fix: the supabase-js library
// must be vendored, same-origin, complete, and fully precached by the service
// worker - and supabase-client.js must never go back to a static CDN import.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { posix } from "node:path";

const VENDOR_ROOT = "vendor/supabase-js";
const ENTRY = `${VENDOR_ROOT}/@supabase/supabase-js@2.74.0/index.mjs`;
const XLSX_ROOT = "vendor/xlsx";
const XLSX_ENTRY = `${XLSX_ROOT}/xlsx@0.18.5/index.mjs`;

// Every shipped chunk under vendor/, whichever package it belongs to.
// fetch-vendor.mjs is the crawler that PRODUCES this directory - a dev tool that
// is never imported by the app, so it must not be precached.
const CRAWLER = "vendor/fetch-vendor.mjs";
function chunksUnder(root) {
  return readdirSync(root, { recursive: true })
    .map((f) => String(f).replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .map((f) => `${root}/${f}`)
    .sort();
}

// DISCOVER the roots rather than listing them. This used to name
// vendor/supabase-js and vendor/xlsx as two constants, which meant adding a
// third library precached NOTHING of it and the test still passed - the two
// named roots were in sync, so the guard reported green while the new library
// was missing from the service worker entirely. Offline, that is a hard failure
// ("Could not load the calendar parser") on a page that looks fine online, which
// is the worst place for a gap to hide.
const VENDOR_ROOTS = readdirSync("vendor", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `vendor/${d.name}`)
  .sort();
assert.ok(VENDOR_ROOTS.includes(VENDOR_ROOT), "vendor/supabase-js is gone");
assert.ok(VENDOR_ROOTS.includes(XLSX_ROOT), "vendor/xlsx is gone");

const supabaseFiles = chunksUnder(VENDOR_ROOT);
const vendorFiles = VENDOR_ROOTS.flatMap(chunksUnder).filter((f) => f !== CRAWLER).sort();

assert.ok(supabaseFiles.length >= 10, `vendored supabase graph looks truncated: ${supabaseFiles.length} files`);
assert.ok(existsSync(ENTRY), `missing vendored entry ${ENTRY}`);
assert.ok(existsSync(XLSX_ENTRY), `missing vendored entry ${XLSX_ENTRY}`);

// --- the vendored copy is the real library, not an esm.sh redirect stub ------
const mod = await import(pathToFileURL(ENTRY).href);
assert.equal(typeof mod.createClient, "function", "vendored entry has no createClient export");
assert.equal(typeof mod.SupabaseClient, "function", "vendored entry has no SupabaseClient export");
const client = mod.createClient("https://example.supabase.co", "anon-key");
assert.equal(typeof client.from, "function");
assert.equal(typeof client.auth, "object");

// --- nothing in the graph reaches back out to a CDN at runtime --------------
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;
for (const file of vendorFiles) {
  const src = readFileSync(file, "utf8");
  for (const [, , spec] of src.matchAll(SPEC_RE)) {
    // Bare specifiers are skipped: the minified bundles embed import snippets
    // inside error-message strings (realtime-js suggests `import ws from "ws"`)
    // and no regex can tell those from code. The successful import of the entry
    // above is what proves the real graph resolves with nothing installed.
    if (!/^(\.{1,2}\/|\/|https?:)/.test(spec)) continue;
    assert.ok(
      spec.startsWith("./") || spec.startsWith("../"),
      `${file} imports non-relative "${spec}" - that defeats vendoring`
    );
    const target = posix.normalize(posix.join(posix.dirname(file), spec));
    assert.ok(existsSync(target), `${file} imports missing chunk ${target}`);
  }
}

// --- the service worker precaches every chunk, or offline is still broken ---
const sw = readFileSync("sw.js", "utf8");
const vendorBlock = sw.match(/const VENDOR = \[([\s\S]*?)\];/);
assert.ok(vendorBlock, "sw.js has no VENDOR precache list");
const precached = [...vendorBlock[1].matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(
  precached,
  vendorFiles,
  "sw.js VENDOR list is out of sync with vendor/ - offline load would fail on the missing chunk"
);

// --- the client loads it dynamically, from the vendored path ----------------
const clientSrc = readFileSync("src/services/supabase-client.js", "utf8");
assert.ok(
  !/^\s*import\s[^\n]*esm\.sh/m.test(clientSrc),
  "supabase-client.js still has a static esm.sh import - one CDN hiccup blanks every page"
);
const vendoredConst = clientSrc.match(/const VENDORED = "([^"]+)"/);
assert.ok(vendoredConst, "supabase-client.js does not declare VENDORED");
const resolved = posix.normalize(posix.join("src/services", vendoredConst[1]));
assert.equal(resolved, ENTRY, `VENDORED points at ${resolved}, which is not the vendored entry`);
assert.ok(/await import\(/.test(clientSrc), "the library import must be dynamic");

// --- same guarantee for the spreadsheet parser ------------------------------
// src/pages/money.js pulls statement-import.js in transitively, so a STATIC
// esm.sh import here killed the whole money page whenever that CDN was slow,
// blocked or unreachable - the identical failure supabase-js was already fixed
// for. sw.js explicitly refuses to cache esm.sh, so it was re-fetched over the
// network on every money page load.
// The lazy load lives in src/imports/sheet-reader.js, which is the only module
// that touches the sheet library. Both it and statement-import.js are checked:
// a static esm.sh import in EITHER is enough to blank the money page.
for (const path of ["src/services/statement-import.js", "src/imports/sheet-reader.js"]) {
  assert.ok(
    !/^\s*import\s[^\n]*esm\.sh/m.test(readFileSync(path, "utf8")),
    `${path} still has a static esm.sh import - one CDN hiccup blanks the whole money page`
  );
}
const readerSrc = readFileSync("src/imports/sheet-reader.js", "utf8");
const xlsxConst = readerSrc.match(/const VENDORED_XLSX = "([^"]+)"/);
assert.ok(xlsxConst, "sheet-reader.js does not declare VENDORED_XLSX");
const xlsxResolved = posix.normalize(posix.join("src/imports", xlsxConst[1]));
assert.equal(xlsxResolved, XLSX_ENTRY, `VENDORED_XLSX points at ${xlsxResolved}, not the vendored entry`);
assert.ok(/await import\(/.test(readerSrc), "the parser import must be dynamic");

// It must load lazily, not at module scope: the 425KB parser is only needed when
// a file is actually dropped.
assert.ok(
  /export async function loadSheetLibrary\(\)/.test(readerSrc),
  "the parser should load behind a call-time loader, not at import time"
);

// The library must never interpret cells. Handed Kotak's `01-04-2026` with
// cellDates on, SheetJS returns 4 JANUARY - a silent three-month error on every
// ambiguous-looking date in the file. Cells are read as raw text and dated by
// lib/statement-shape.mjs using evidence from the whole statement.
assert.ok(/cellDates:\s*false/.test(readerSrc), "sheet-reader must disable date coercion");
assert.ok(/raw:\s*true/.test(readerSrc), "sheet-reader must read cells raw");

// The vendored parser really is SheetJS, not an esm.sh redirect stub.
const xlsxMod = await import(pathToFileURL(XLSX_ENTRY).href);
assert.equal(typeof xlsxMod.read, "function", "vendored xlsx entry has no read export");
assert.equal(typeof xlsxMod.utils?.sheet_to_json, "function", "vendored xlsx entry has no utils.sheet_to_json");

console.log(`vendor-offline tests passed: ${vendorFiles.length} chunks vendored + precached across ${VENDOR_ROOTS.length} roots (${VENDOR_ROOTS.map((r) => r.slice(7)).join(", ")})`);
