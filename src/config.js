// Runtime config loader.
//
// Resolution order:
//   1. `src/config.local.js` (gitignored) if present at build/serve time.
//   2. `localStorage` keys SUPABASE_URL + SUPABASE_ANON_KEY.
//   3. Prompt the user once via the on-screen setup card.
//
// This lets the same static bundle work for any deployment without
// committing keys to the repo.

const LS_URL = "trackerz.supabase_url";
const LS_KEY = "trackerz.supabase_anon_key";

let cached = null;

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

export async function getSupabaseConfig() {
  if (cached) return cached;
  cached = (await loadLocalFile()) || loadLocalStorage();
  return cached;
}

export function hasSupabaseConfig() {
  return Boolean(cached || loadLocalStorage());
}
