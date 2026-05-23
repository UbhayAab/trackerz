import { getSupabaseClient } from "./supabase-client.js";

const sessionListeners = new Set();
let currentSession = null;
let initPromise = null;

export function onAuthChange(listener) {
  sessionListeners.add(listener);
  listener(currentSession);
  return () => sessionListeners.delete(listener);
}

function notify() {
  for (const l of sessionListeners) l(currentSession);
}

export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const supabase = await getSupabaseClient();
    const { data } = await supabase.auth.getSession();
    currentSession = data.session;
    notify();
    supabase.auth.onAuthStateChange((_event, session) => {
      currentSession = session;
      notify();
    });
    return currentSession;
  })();
  return initPromise;
}

export function getCurrentSession() {
  return currentSession;
}

export async function signInWithEmail(email) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: globalThis.location?.href },
  });
  if (error) throw error;
}

const SUPPORTED_PROVIDERS = new Set(["google", "github", "apple", "facebook", "azure", "discord", "linkedin", "slack", "spotify", "twitter", "notion", "kakao", "workos", "zoom"]);

export async function signInWithProvider(provider) {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  const supabase = await getSupabaseClient();
  const redirect = globalThis.location?.origin
    ? `${globalThis.location.origin}${globalThis.location.pathname.replace(/[^/]*$/, "")}`
    : undefined;
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: redirect ? { redirectTo: redirect } : undefined,
  });
  if (error) throw error;
}

export async function signOut() {
  const supabase = await getSupabaseClient();
  await supabase.auth.signOut();
  currentSession = null;
  notify();
}

export async function ensureProfileRow() {
  if (!currentSession?.user) return;
  const supabase = await getSupabaseClient();
  const userId = currentSession.user.id;
  await supabase
    .from("profiles")
    .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
}
