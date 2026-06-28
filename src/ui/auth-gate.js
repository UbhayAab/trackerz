import { hasSupabaseConfig, primeSupabaseConfig, saveConfig } from "../config.js";
import { initAuth, onAuthChange, signInLocal, signInWithEmail, signInWithPassword, signInWithProvider, signOut, ensureProfileRow, getCurrentSession, isLocalSession } from "../services/auth.js";
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
      <input type="url" id="setupUrl" placeholder="https://your-project.supabase.co" value="https://yyoewdcijplkhxleejtm.supabase.co" />
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
    <div class="auth-brand">
      <span class="auth-logo" aria-hidden="true">◆</span>
      <div class="auth-brand-text">
        <strong>Trackerz</strong>
        <span>Capture money, food &amp; wellness — your AI sorts it.</span>
      </div>
    </div>
    <h2>Sign in</h2>
    <p class="muted small">Private to you. Every row is RLS-isolated by your user id.</p>
    <label>Username or email
      <input type="text" id="pwUser" value="Ubhay" autocomplete="username" autocapitalize="none" />
    </label>
    <label>Password
      <input type="password" id="pwPass" placeholder="••••••••" autocomplete="current-password" />
    </label>
    <button type="button" id="pwSignin" class="primary-button">Sign in</button>
    <p id="pwMessage" class="muted small" role="status" aria-live="polite"></p>
    <div class="auth-divider"><span>or use another method</span></div>
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
    <div class="auth-divider"><span>or magic link</span></div>
    <label>Email
      <input type="email" id="signinEmail" placeholder="you@example.com" autocomplete="email" />
    </label>
    <button type="button" id="signinSend" class="primary-button">Send magic link</button>
    <p id="signinMessage" class="muted small" role="status" aria-live="polite"></p>
    <details class="local-mode">
      <summary>Developer · local test mode</summary>
      <div class="local-auth-box">
        <label>Name
          <input type="text" id="localName" placeholder="You" autocomplete="name" />
        </label>
        <label>Email
          <input type="email" id="localEmail" placeholder="local@trackerz.app" autocomplete="email" />
        </label>
        <button type="button" id="localSignin" class="secondary-button">Continue locally (no sync)</button>
      </div>
    </details>
  `;
  const message = card.querySelector("#signinMessage");
  const pwMessage = card.querySelector("#pwMessage");
  const doPasswordSignin = async () => {
    const user = card.querySelector("#pwUser").value.trim();
    const pass = card.querySelector("#pwPass").value;
    if (!user || !pass) { pwMessage.textContent = "Enter your username and password."; return; }
    pwMessage.textContent = "Signing in...";
    try {
      await signInWithPassword(user, pass);
      pwMessage.textContent = "Signed in.";
    } catch (err) {
      pwMessage.textContent = `Sign-in failed: ${err.message || err}`;
    }
  };
  card.querySelector("#pwSignin").addEventListener("click", doPasswordSignin);
  card.querySelector("#pwPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doPasswordSignin(); });
  card.querySelector("#localSignin").addEventListener("click", async () => {
    message.textContent = "Starting local session...";
    const session = await signInLocal({
      name: card.querySelector("#localName").value.trim() || "You",
      email: card.querySelector("#localEmail").value.trim() || "local@trackerz.app",
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

// The account control IS the existing topbar Settings link, collapsed to a
// compact avatar (the user's initial) — no sprawling email in the bar. Account
// details + sign-out live on the Settings page the link already points to.
function renderAuthPill(session) {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  // Remove any old full-email pill from a previous build.
  document.getElementById(PILL_ID)?.remove();

  const link = topbar.querySelector(".icon-link");
  if (!link) return;
  if (session?.user) {
    const email = session.user.email || "";
    const mode = isLocalSession(session) ? " · local" : "";
    link.textContent = (email.trim()[0] || "U").toUpperCase();
    link.classList.add("account-avatar");
    link.title = `${email || "signed in"}${mode}`;
    link.setAttribute("aria-label", `Account & settings (${email || "signed in"})`);
  } else {
    link.classList.remove("account-avatar");
  }
}

function removeCard(id) {
  document.getElementById(id)?.remove();
}

export function isAuthed() {
  return Boolean(getCurrentSession());
}
