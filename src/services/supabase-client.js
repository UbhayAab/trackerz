import { getSupabaseConfig } from "../config.js";

// supabase-js used to be a STATIC import from esm.sh. Every page entry pulls
// this module in transitively, so when that CDN was slow, blocked or the device
// was offline the import rejected and NO page module ran at all: no bottom nav,
// diet stuck on "Loading…", Process button dead. The library is now vendored
// (same-origin, precached by sw.js) and loaded dynamically, so a load failure
// costs us the database - not the whole app.
const VENDORED = "../../vendor/supabase-js/@supabase/supabase-js@2.74.0/index.mjs";
// Kept only as a rescue path for a partial/stale deploy where vendor/ is
// missing. It is tried second, and offline it simply fails like the first.
const CDN = "https://esm.sh/@supabase/supabase-js@2.74.0";
const BANNER_ID = "trackerz-supabase-lib-error";

let libPromise = null;
let clientPromise = null;

async function loadSupabaseLib() {
  const attempts = [];
  for (const specifier of [VENDORED, CDN]) {
    try {
      const mod = await import(specifier);
      // An esm.sh redirect stub or a 404 served as HTML can import "fine" and
      // still hand back something without the library in it. Treating that as
      // success would fail later, somewhere unrelated and unexplainable.
      if (typeof mod?.createClient !== "function") {
        throw new Error("loaded module has no createClient export");
      }
      if (specifier === CDN) {
        console.warn("supabase-js: vendored copy unavailable, loaded from CDN instead");
      }
      return mod;
    } catch (err) {
      attempts.push(`${specifier} -> ${err?.message || String(err)}`);
    }
  }
  throw new Error(`supabase_library_unavailable: ${attempts.join(" ; ")}`);
}

function getSupabaseLib() {
  if (!libPromise) {
    const pending = loadSupabaseLib();
    libPromise = pending;
    pending.catch((err) => {
      // Do not memoize the failure: the next call (back online, or after the
      // service worker has the vendored copy) must be allowed to succeed.
      if (libPromise === pending) libPromise = null;
      showLibraryFailureBanner(err);
    });
  }
  return libPromise;
}

export function getSupabaseClient() {
  if (!clientPromise) {
    const pending = (async () => {
      const { createClient } = await getSupabaseLib();
      const cfg = await getSupabaseConfig();
      if (!cfg) {
        throw new Error("supabase_not_configured");
      }
      return createClient(cfg.url, cfg.key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    })();
    clientPromise = pending;
    // Same reasoning as above: a cached rejected promise used to make one
    // offline moment permanent for the rest of the page's life.
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = null;
    });
  }
  return clientPromise;
}

export function resetSupabaseClient() {
  clientPromise = null;
}

// Last-resort visible failure. Every caller of getSupabaseClient() already
// surfaces its own error, but if the library itself is missing then nothing on
// the page has real data behind it, and that must be stated outright rather
// than left to look like empty-but-loaded.
function showLibraryFailureBanner(err) {
  if (typeof document === "undefined") return;
  const render = () => {
    if (!document.body || document.getElementById(BANNER_ID)) return;
    const bar = document.createElement("div");
    bar.id = BANNER_ID;
    bar.setAttribute("role", "alert");
    // Inline styles on purpose: the same failure mode (offline / blocked
    // network) can also mean styles.css never arrived.
    bar.style.cssText =
      "position:sticky;top:0;z-index:9999;padding:10px 14px;background:#7f1d1d;color:#fff;" +
      "font:14px/1.4 system-ui,sans-serif;display:flex;gap:10px;align-items:center;flex-wrap:wrap";
    const text = document.createElement("span");
    text.style.flex = "1 1 220px";
    text.textContent =
      "Could not load the database library, so nothing on this page is real data - " +
      "no totals, logs or plans have been read. Reconnect and reload.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Reload";
    retry.style.cssText =
      "padding:6px 12px;border:1px solid #fff;border-radius:6px;background:transparent;color:#fff;cursor:pointer";
    retry.addEventListener("click", () => globalThis.location?.reload());
    const detail = document.createElement("code");
    detail.style.cssText = "flex:1 1 100%;font-size:11px;opacity:.85;word-break:break-word";
    detail.textContent = err?.message || String(err);
    bar.append(text, retry, detail);
    document.body.prepend(bar);
  };
  if (document.body) render();
  else document.addEventListener("DOMContentLoaded", render, { once: true });
}
