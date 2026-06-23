// Runtime config loader.
//
// Resolution order:
//   1. `src/config.local.js` (gitignored) if present.
//   2. `localStorage` overrides for testing other projects.
//   3. Hard-coded production defaults below.
//
// The publishable (anon) key is safe to embed in client code BECAUSE every
// user-owned table has Row Level Security enabled and policies that only
// allow auth.uid() = row.user_id. The setup card stays as a fallback for
// people forking the repo to point at their own Supabase project.

// Live project ref: yyoewdcijplkhxleejtm. A previous build shipped the ref
// `qmlenovxatoyxxqlvzlo`, which no longer resolves (DNS NXDOMAIN) — pointing the
// app there was why sign-in/capture silently did nothing. The anon key below is
// the publishable key minted from this (yyoe) project; RLS protects every table.
const PROD_URL = "https://yyoewdcijplkhxleejtm.supabase.co";
const PROD_ANON_KEY = "sb_publishable_0AfWy1NnROvjW0P0Cj3KVA_m286sLXT";
// Dead ref kept ONLY to self-heal browsers that cached it in localStorage.
const OLD_MISMATCHED_URL = "https://qmlenovxatoyxxqlvzlo.supabase.co";

const LS_URL = "trackerz.supabase_url";
const LS_KEY = "trackerz.supabase_anon_key";

let cached = null;
let primePromise = null;

async function loadLocalFile() {
  try {
    const mod = await import("./config.local.js");
    if (mod?.SUPABASE_URL && mod?.SUPABASE_ANON_KEY) {
      return { url: mod.SUPABASE_URL, key: mod.SUPABASE_ANON_KEY };
    }
  } catch {
    // Optional file. Fall through.
  }
  return null;
}

function loadLocalStorage() {
  try {
    const url = globalThis.localStorage?.getItem(LS_URL);
    const key = globalThis.localStorage?.getItem(LS_KEY);
    // Self-heal: any browser still holding the dead project ref gets it wiped so
    // the working PROD default takes over on next load.
    if (url === OLD_MISMATCHED_URL) {
      globalThis.localStorage?.removeItem(LS_URL);
      globalThis.localStorage?.removeItem(LS_KEY);
      return null;
    }
    return url && key ? { url, key } : null;
  } catch {
    return null;
  }
}

export function saveConfig(url, key) {
  globalThis.localStorage?.setItem(LS_URL, url);
  globalThis.localStorage?.setItem(LS_KEY, key);
  cached = { url, key };
}

export function clearConfig() {
  globalThis.localStorage?.removeItem(LS_URL);
  globalThis.localStorage?.removeItem(LS_KEY);
  cached = null;
}

function loadProdDefault() {
  if (PROD_URL && PROD_ANON_KEY) return { url: PROD_URL, key: PROD_ANON_KEY };
  return null;
}

export async function getSupabaseConfig() {
  if (cached) return cached;
  cached = (await loadLocalFile()) || loadLocalStorage() || loadProdDefault();
  return cached;
}

// Call once at app boot. Awaits the local file lookup so subsequent sync
// hasSupabaseConfig() checks see config.local.js too.
export function primeSupabaseConfig() {
  if (!primePromise) primePromise = getSupabaseConfig();
  return primePromise;
}

export function hasSupabaseConfig() {
  return Boolean(cached || loadLocalStorage() || loadProdDefault());
}
