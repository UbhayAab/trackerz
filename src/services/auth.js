import { getSupabaseClient } from "./supabase-client.js";

const LOCAL_SESSION_KEY = "trackerz_local_auth_session_v1";
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
    const local = getStoredLocalSession();
    if (local) {
      currentSession = local;
      notify();
      return currentSession;
    }

    try {
      const supabase = await getSupabaseClient();
      const { data } = await supabase.auth.getSession();
      currentSession = data.session;
      notify();
      supabase.auth.onAuthStateChange((_event, session) => {
        currentSession = session;
        notify();
      });
    } catch {
      currentSession = null;
      notify();
    }
    return currentSession;
  })();
  return initPromise;
}

export function getCurrentSession() {
  return currentSession;
}

export function getStorageUserId() {
  return currentSession?.user?.id || getStoredLocalSession()?.user?.id || "anonymous";
}

export function isLocalSession(session = currentSession) {
  return session?.trackerzMode === "local";
}

export function getStoredLocalSession() {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function signInLocal({ email, name } = {}) {
  const cleanedEmail = normalizeEmail(email) || "ubhay@test.local";
  currentSession = {
    trackerzMode: "local",
    access_token: "local-dev-session",
    user: {
      id: `local:${cleanedEmail}`,
      email: cleanedEmail,
      user_metadata: {
        name: name?.trim() || cleanedEmail.split("@")[0] || "Trackerz user",
      },
    },
  };
  globalThis.localStorage?.setItem(LOCAL_SESSION_KEY, JSON.stringify(currentSession));
  notify();
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

// Short handles -> real account emails, so sign-in can be "Ubhay" + a password
// instead of a full email. Anything containing "@" is treated as an email as-is.
const USERNAME_ALIASES = {
  ubhay: "ubhayvatsaanand@gmail.com",
};

export async function signInWithPassword(identifier, password) {
  const raw = String(identifier || "").trim();
  const email = raw.includes("@") ? normalizeEmail(raw) : (USERNAME_ALIASES[raw.toLowerCase()] || raw);
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
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
  globalThis.localStorage?.removeItem(LOCAL_SESSION_KEY);
  if (!isLocalSession()) {
    try {
      const supabase = await getSupabaseClient();
      await supabase.auth.signOut();
    } catch {
      // A local sign-out should still clear the UI if the network is down.
    }
  }
  currentSession = null;
  notify();
}

export async function ensureProfileRow() {
  if (!currentSession?.user || isLocalSession()) return;
  const supabase = await getSupabaseClient();
  const userId = currentSession.user.id;
  await supabase
    .from("profiles")
    .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}
