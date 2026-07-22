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

// Surfaced to the UI so a failed session restore is visible instead of looking
// like "you were signed out".
let lastAuthError = null;
export function getLastAuthError() {
  return lastAuthError;
}

export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // The REAL session always wins. This used to return the localStorage
    // "developer local test mode" session before ever contacting Supabase, so
    // one tap on "Continue locally" permanently shadowed the real account: the
    // app looked signed in, every query ran as `local:<email>`, and the owner's
    // own data was invisible with no way back except clearing site data.
    try {
      const supabase = await getSupabaseClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        lastAuthError = error.message || String(error);
      } else if (data?.session) {
        clearLocalSession();
        currentSession = data.session;
        notify();
        supabase.auth.onAuthStateChange((_event, session) => {
          currentSession = session;
          notify();
        });
        return currentSession;
      }
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session) clearLocalSession();
        currentSession = session || getStoredLocalSession();
        notify();
      });
    } catch (err) {
      // A network/CDN failure is NOT "signed out" - say so, so the sign-in card
      // does not silently blame the user for a broken connection.
      lastAuthError = err?.message || String(err);
    }

    currentSession = getStoredLocalSession();
    notify();
    return currentSession;
  })();
  return initPromise;
}

export function clearLocalSession() {
  try { globalThis.localStorage?.removeItem(LOCAL_SESSION_KEY); } catch { /* private mode */ }
}

// Leave local test mode without nuking the whole origin's storage.
export async function exitLocalSession() {
  clearLocalSession();
  currentSession = null;
  initPromise = null;
  notify();
  await initAuth();
  return currentSession;
}

// Send a password-reset link. Without this the password form was a dead end:
// there was no way to set or recover a password anywhere in the app.
export async function sendPasswordReset(email) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
    redirectTo: appRedirectUrl(),
  });
  if (error) throw error;
}

// Complete the reset once the user lands back from the emailed link.
export async function updatePassword(newPassword) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// Supabase bounces OAuth / magic-link failures back to the app as query or hash
// params. Nothing read them, so "Continue with Google" looked like it silently
// did nothing. Returns a human-readable reason, or null.
export function readAuthRedirectError() {
  const loc = globalThis.location;
  if (!loc) return null;
  const fromHash = new URLSearchParams(String(loc.hash || "").replace(/^#/, ""));
  const fromQuery = new URLSearchParams(loc.search || "");
  const code = fromHash.get("error") || fromQuery.get("error")
    || fromHash.get("error_code") || fromQuery.get("error_code");
  if (!code) return null;
  const desc = fromHash.get("error_description") || fromQuery.get("error_description") || "";
  const readable = decodeURIComponent(desc.replace(/\+/g, " ")) || code;
  // Clean the URL so the banner does not survive a refresh forever.
  try {
    history.replaceState(null, "", `${loc.pathname}${loc.search.replace(/[?&]error[^&]*/g, "")}`);
  } catch { /* non-browser */ }
  return readable;
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

// The app's own origin+directory, which must also be in the Supabase project's
// redirect allow-list or GoTrue silently downgrades to site_url.
export function appRedirectUrl() {
  const loc = globalThis.location;
  if (!loc?.origin) return undefined;
  return `${loc.origin}${loc.pathname.replace(/[^/]*$/, "")}`;
}

export async function signInWithEmail(email) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizeEmail(email),
    options: {
      emailRedirectTo: appRedirectUrl(),
      // A typo used to silently create a brand-new empty account and then report
      // success, which looks identical to "my data vanished".
      shouldCreateUser: false,
    },
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
  const redirect = appRedirectUrl();

  // signInWithOAuth only builds a URL and navigates - it resolves with
  // error:null even when the provider is DISABLED server-side, so the old code
  // could never report a failure. Ask the authorize endpoint first: a disabled
  // provider answers with a 400/error redirect, which we can show as text
  // instead of ejecting the user to a Supabase error page.
  const probe = await providerAvailability(provider);
  if (probe.enabled === false) {
    throw new Error(
      `${provider[0].toUpperCase()}${provider.slice(1)} sign-in is not enabled on this Supabase project` +
      `${probe.reason ? ` (${probe.reason})` : ""}. Use your email and password, or enable the provider in ` +
      `Supabase → Authentication → Providers.`,
    );
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: redirect ? { redirectTo: redirect } : undefined,
  });
  if (error) throw error;
}

// GoTrue publishes which providers are actually turned on. This is the only
// reliable way to know: signInWithOAuth builds the authorize URL locally and
// navigates, so it resolves error:null even for a disabled provider, and
// probing /authorize cross-origin only yields an opaque response.
// Fetched once per page load. Never throws - an inconclusive probe returns null
// and the normal redirect is allowed to proceed.
let providerSettingsPromise = null;

export function getEnabledProviders() {
  if (!providerSettingsPromise) {
    providerSettingsPromise = (async () => {
      try {
        const { getSupabaseConfig } = await import("../config.js");
        const cfg = await getSupabaseConfig();
        if (!cfg?.url || !cfg?.key) return null;
        const res = await fetch(`${cfg.url}/auth/v1/settings`, { headers: { apikey: cfg.key } });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.external || null;
      } catch {
        return null;
      }
    })();
  }
  return providerSettingsPromise;
}

export async function providerAvailability(provider) {
  const external = await getEnabledProviders();
  if (!external || !(provider in external)) return { enabled: null };
  return external[provider]
    ? { enabled: true }
    : { enabled: false, reason: "disabled in Supabase → Authentication → Providers" };
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
