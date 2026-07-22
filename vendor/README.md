# vendor/

Third-party browser libraries shipped **with the site** instead of pulled from a CDN.

## Why

`src/services/supabase-client.js` is on every page's import chain
(`src/pages/*.js` -> `bootstrap.js` -> `auth-gate.js` -> `auth.js` -> `supabase-client.js`).
When it did a static `import ... from "https://esm.sh/..."` and esm.sh was slow,
blocked or the device was offline, that import rejected and **no page module ran
at all** — no bottom nav, diet stuck on "Loading…", Process button dead. A
cross-origin CDN also cannot be fixed by the service worker in a useful way.

Vendoring makes the library same-origin, so `sw.js` precaches it and the app
works fully offline.

## supabase-js@2.74.0

`vendor/supabase-js/` is the complete esm.sh module graph for
`https://esm.sh/@supabase/supabase-js@2.74.0` — 13 files, ~220 KB — with every
absolute `/...` esm.sh specifier rewritten to a relative path. Entry point:

    vendor/supabase-js/@supabase/supabase-js@2.74.0/index.mjs

Nothing in the graph reaches back out to esm.sh at runtime.

## Regenerating (version bump)

    node vendor/fetch-vendor.mjs vendor/supabase-js /@supabase/supabase-js@<version>

Then update, in lockstep:

1. `VENDORED` in `src/services/supabase-client.js` (the version is in the path),
2. the `VENDOR` precache list **and** `VERSION` in `sw.js` (list every file the
   crawler prints — `cache.addAll` does not follow ES module imports),
3. `tests/vendor-offline.test.mjs`, which fails if these drift apart.

Delete the old version directory; version-pinned paths are served cache-first
and are never revalidated.
