// Renders current user details + provider linking + sign-out into the
// Settings page. Re-renders on every auth change.

import { getCurrentSession, onAuthChange, signOut, signInWithProvider } from "../services/auth.js";
import { getSupabaseClient } from "../services/supabase-client.js";

function fmtProviders(identities = []) {
  if (!identities.length) return "email";
  const names = identities.map((i) => i.provider).filter(Boolean);
  return [...new Set(names)].join(", ") || "email";
}

async function linkProvider(provider, statusEl) {
  try {
    statusEl.textContent = `linking ${provider}...`;
    const supabase = await getSupabaseClient();
    const fn = supabase.auth.linkIdentity?.bind(supabase.auth);
    if (!fn) {
      statusEl.textContent = "this supabase-js version cannot link identities; sign out and sign in with the provider";
      return;
    }
    const redirect = `${globalThis.location.origin}${globalThis.location.pathname.replace(/[^/]*$/, "")}`;
    const { error } = await fn({ provider, options: { redirectTo: redirect } });
    if (error) statusEl.textContent = `error: ${error.message}`;
  } catch (err) {
    statusEl.textContent = `error: ${err.message || err}`;
  }
}

export function mountAccountPanel() {
  const panel = document.getElementById("accountPanel");
  if (!panel) return;

  const emailEl = panel.querySelector("#accountEmail");
  const uidEl = panel.querySelector("#accountUid");
  const providersEl = panel.querySelector("#accountProviders");
  const statusEl = panel.querySelector("#accountStatus");

  const render = (session) => {
    if (!session?.user) {
      emailEl.textContent = "-";
      uidEl.textContent = "-";
      providersEl.textContent = "-";
      statusEl.textContent = "signed out";
      return;
    }
    const user = session.user;
    emailEl.textContent = user.email || user.phone || "anonymous";
    uidEl.textContent = (user.id || "").slice(0, 8) + "…";
    providersEl.textContent = fmtProviders(user.identities);
    statusEl.textContent = "active";
  };

  render(getCurrentSession());
  onAuthChange(render);

  panel.querySelector("#signOutBtn")?.addEventListener("click", async () => {
    statusEl.textContent = "signing out...";
    await signOut();
    statusEl.textContent = "signed out";
  });

  panel.querySelector("#linkGoogle")?.addEventListener("click", () => linkProvider("google", statusEl));
  panel.querySelector("#linkGithub")?.addEventListener("click", () => linkProvider("github", statusEl));
}
