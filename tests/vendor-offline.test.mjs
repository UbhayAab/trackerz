// Guards the "dead HTML shell when esm.sh is down" fix: the supabase-js library
// must be vendored, same-origin, complete, and fully precached by the service
// worker — and supabase-client.js must never go back to a static CDN import.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { posix } from "node:path";

const VENDOR_ROOT = "vendor/supabase-js";
const ENTRY = `${VENDOR_ROOT}/@supabase/supabase-js@2.74.0/index.mjs`;

const vendorFiles = readdirSync(VENDOR_ROOT, { recursive: true })
  .map((f) => String(f).replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
  .map((f) => `${VENDOR_ROOT}/${f}`)
  .sort();

assert.ok(vendorFiles.length >= 10, `vendored graph looks truncated: ${vendorFiles.length} files`);
assert.ok(existsSync(ENTRY), `missing vendored entry ${ENTRY}`);

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
      `${file} imports non-relative "${spec}" — that defeats vendoring`
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
  "sw.js VENDOR list is out of sync with vendor/ — offline load would fail on the missing chunk"
);

// --- the client loads it dynamically, from the vendored path ----------------
const clientSrc = readFileSync("src/services/supabase-client.js", "utf8");
assert.ok(
  !/^\s*import\s[^\n]*esm\.sh/m.test(clientSrc),
  "supabase-client.js still has a static esm.sh import — one CDN hiccup blanks every page"
);
const vendoredConst = clientSrc.match(/const VENDORED = "([^"]+)"/);
assert.ok(vendoredConst, "supabase-client.js does not declare VENDORED");
const resolved = posix.normalize(posix.join("src/services", vendoredConst[1]));
assert.equal(resolved, ENTRY, `VENDORED points at ${resolved}, which is not the vendored entry`);
assert.ok(/await import\(/.test(clientSrc), "the library import must be dynamic");

console.log(`vendor-offline tests passed: ${vendorFiles.length} chunks vendored + precached`);
