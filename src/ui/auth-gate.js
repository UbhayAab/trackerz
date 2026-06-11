import { hasSupabaseConfig, primeSupabaseConfig, saveConfig } from "../config.js";
import { initAuth, onAuthChange, signInLocal, signInWithEmail, signInWithProvider, signOut, ensureProfileRow, getCurrentSession, isLocalSession } from "../services/auth.js";
import { resetSupabaseClient } from "../services/supabase-client.js";

const SETUP_ID = "trackerz-setup-card";
const SIGNIN_ID = "trackerz-signin-card";
const PILL_ID = "trackerz-auth-pill";

export async function mountAuthGate({ onReady } = {}) {
  // Wait for config.local.js (if present) before deciding to show setup.
  await primeSupabaseConfig();

  if (!hasSupabaseConfig()) {
    showSetupCard(() => mountAuthGate({ onReady }));
    return;
  }
  removeCard(SETUP_ID);

  await initAuth();
  onAuthChange(async (session) => {
    renderAuthPill(session);
    if (session) {
      removeCard(SIGNIN_ID);
      try { await ensureProfileRow(); } catch {}
      onReady?.(session);
    } else {
      showSignInCard();
    }
  });
}

function showSetupCard(onSaved) {
  removeCard(SIGNIN_ID);
  let card = document.getElementById(SETUP_ID);
  if (!card) {
    card = document.createElement("section");
    card.id = SETUP_ID;
    card.className = "auth-card setup-card";
    document.body.appendChild(card);
  }
  card.innerHTML = `
    <h2>One-time setup</h2>
    <p>Paste your Supabase project URL and anon (publishable) key. Stored only in this browser.</p>
    <label>Supabase URL
      <input type="url" id="setupUrl" placeholder="https://your-project.supabase.co" value="https://qmlenovxatoyxxqlvzlo.supabase.co" />
    </label>
    <label>Supabase anon key
      <input type="password" id="setupKey" placeholder="eyJhbGciOi..." />
    </label>
    <button type="button" id="setupSave" class="primary-button">Save</button>
    <p class="muted small">Get these from Supabase dashboard -> Project Settings -> API.</p>
  `;
  card.querySelector("#setupSave").addEventListener("click", () => {
    const url = card.querySelector("#setupUrl").value.trim();
    const key = card.querySelector("#setupKey").value.trim();
    if (!url || !key) return;
    saveConfig(url, key);
    resetSupabaseClient();
    onSaved?.();
  });
}

function showSignInCard() {
  let card = document.getElementById(SIGNIN_ID);
  if (!card) {
    card = document.createElement("section");
    card.id = SIGNIN_ID;
    card.className = "auth-card signin-card";
    document.body.appendChild(card);
  }
  card.innerHTML = `
    <h2>Sign in to Trackerz</h2>
    <p class="muted small">Private to you. Your data is RLS-isolated by user id.</p>
    <div class="local-auth-box">
      <label>Name
        <input type="text" id="localName" value="Ubhay" autocomplete="name" />
      </label>
      <label>Email
        <input type="email" id="localEmail" value="ubhay@test.local" autocomplete="email" />
      </label>
      <button type="button" id="localSignin" class="primary-button">Continue locally</button>
      <p class="muted small">Fast local mode for testing this browser. Supabase sign-in stays below for real sync.</p>
    </div>
    <div class="auth-divider"><span>or Supabase</span></div>
    <div class="oauth-row">
      <button type="button" class="oauth-button" data-provider="google">
        <span class="oauth-glyph oauth-google" aria-hidden="true"></span>
        Continue with Google
      </button>
      <button type="button" class="oauth-button" data-provider="github">
        <span class="oauth-glyph oauth-github" aria-hidden="true"></span>
        Continue with GitHub
      </button>
    </div>
    <div class="auth-divider"><span>magic link</span></div>
    <label>Email
      <input type="email" id="signinEmail" placeholder="you@example.com" autocomplete="email" />
    </label>
    <button type="button" id="signinSend" class="primary-button">Send magic link</button>
    <p id="signinMessage" class="muted small"></p>
  `;
  const message = card.querySelector("#signinMessage");
  card.querySelector("#localSignin").addEventListener("click", async () => {
    message.textContent = "Starting local session...";
    const session = await signInLocal({
      name: card.querySelector("#localName").value,
      email: card.querySelector("#localEmail").value,
    });
    message.textContent = `Local session ready for ${session.user.email}.`;
  });
  card.querySelectorAll(".oauth-button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const provider = btn.dataset.provider;
      message.textContent = `Opening ${provider}...`;
      try {
        await signInWithProvider(provider);
      } catch (err) {
        message.textContent = `Error: ${err.message || err}`;
      }
    });
  });
  card.querySelector("#signinSend").addEventListener("click", async () => {
    const email = card.querySelector("#signinEmail").value.trim();
    if (!email) return;
    message.textContent = "Sending...";
    try {
      await signInWithEmail(email);
      message.textContent = `Check ${email} for a sign-in link.`;
    } catch (err) {
      message.textContent = `Error: ${err.message || err}`;
    }
  });
}

function renderAuthPill(session) {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  let pill = document.getElementById(PILL_ID);
  if (!pill) {
    pill = document.createElement("button");
    pill.id = PILL_ID;
    pill.type = "button";
    pill.className = "status-pill auth-pill";
    topbar.appendChild(pill);
  }
  if (session?.user) {
    const mode = isLocalSession(session) ? "local" : "sync";
    pill.textContent = `${session.user.email || "signed in"} (${mode})`;
    pill.title = "Click to sign out";
    pill.onclick = () => signOut();
  } else {
    pill.textContent = "signed out";
    pill.onclick = null;
  }
}

function removeCard(id) {
  document.getElementById(id)?.remove();
}

export function isAuthed() {
  return Boolean(getCurrentSession());
}
