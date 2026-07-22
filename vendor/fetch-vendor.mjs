// Vendoring crawler: downloads an esm.sh module graph and rewrites every
// absolute esm.sh specifier to a relative same-origin path, so the result can
// be served from this repo and precached by the service worker. Run by hand on
// a version bump — see vendor/README.md. Not part of any build; there is none.
//
// Usage: node vendor/fetch-vendor.mjs <destDir> [/pkg@version]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const ORIGIN = "https://esm.sh";
const ROOT = process.argv[2];
const ENTRY = process.argv[3] || "/@supabase/supabase-js@2.74.0";

if (!ROOT) {
  console.error("usage: node vendor/fetch-vendor.mjs <destDir> [/pkg@version]");
  process.exit(1);
}

const seen = new Set();

function localFor(urlPath) {
  let p = urlPath.replace(/^\//, "");
  // esm.sh's package entry is extensionless; give it a real filename. Not
  // "_"-prefixed: GitHub Pages' Jekyll pass would drop it.
  if (!/\.(mjs|js)$/.test(p)) p = p.replace(/\/$/, "") + "/index.mjs";
  return p;
}

const SPEC_RE = /(\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*|\bimport\s*\(\s*)(["'])(\/[^"']+)\2/g;

async function crawl(urlPath) {
  if (seen.has(urlPath)) return;
  seen.add(urlPath);
  const local = localFor(urlPath);
  const res = await fetch(ORIGIN + urlPath, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${ORIGIN}${urlPath}`);
  const src = await res.text();

  const deps = [];
  const out = src.replace(SPEC_RE, (_m, pre, quote, spec) => {
    deps.push(spec);
    let rel = posix.relative(posix.dirname(local), localFor(spec));
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `${pre}${quote}${rel}${quote}`;
  });

  const dest = join(ROOT, local);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, out);
  console.log(`./${posix.join(ROOT.replaceAll("\\", "/"), local)}  ${out.length} bytes`);
  for (const dep of deps) await crawl(dep);
}

await crawl(ENTRY);
console.log(`\nentry: ${localFor(ENTRY)}\nfiles: ${seen.size}`);
