import { hasSupabaseConfig, primeSupabaseConfig, saveConfig } from "../config.js";
import {
  initAuth, onAuthChange, signInLocal, signInWithEmail, signInWithPassword, signInWithProvider,
  signOut, ensureProfileRow, getCurrentSession, isLocalSession,
  sendPasswordReset, updatePassword, readAuthRedirectError, getLastAuthError, exitLocalSession,
  getEnabledProviders,
} from "../services/auth.js";
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

  // Arriving back from a password-reset email: let the user actually set one.
  if (isRecoveryLanding()) {
    showRecoveryCard();
    return;
  }

  onAuthChange(async (session) => {
    renderAuthPill(session);
    if (session) {
      removeCard(SIGNIN_ID);
      renderLocalModeBanner(session);
      try { await ensureProfileRow(); } catch (err) {
        console.warn("profile upsert failed", err);
      }
      onReady?.(session);
    } else {
      showSignInCard();
    }
  });
}

// Supabase sends the recovery link back with type=recovery in the URL hash.
function isRecoveryLanding() {
  const hash = String(globalThis.location?.hash || "");
  return hash.includes("type=recovery");
}

// Local test mode is a developer escape hatch that looks identical to being
// signed in - except none of the real account's data is there. Make it obvious,
// and give a one-tap way out.
function renderLocalModeBanner(session) {
  document.getElementById("trackerz-local-banner")?.remove();
  if (!isLocalSession(session)) return;
  const bar = document.createElement("div");
  bar.id = "trackerz-local-banner";
  bar.className = "local-mode-banner";
  bar.innerHTML = `
    <span>Local test mode - nothing syncs and your real account's data is not shown.</span>
    <button type="button" id="exitLocalMode" class="secondary-button">Sign in for real</button>
  `;
  document.body.prepend(bar);
  bar.querySelector("#exitLocalMode").addEventListener("click", async () => {
    await exitLocalSession();
    bar.remove();
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
        <span>Capture money, food &amp; wellness - your AI sorts it.</span>
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
    <button type="button" id="pwForgot" class="link-button">Forgot password?</button>
    <p id="pwMessage" class="muted small" role="status" aria-live="polite"></p>
    <p id="authBanner" class="auth-banner" role="alert" hidden></p>
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

  // Surface why sign-in is failing, instead of an empty card. Covers both a
  // bounced OAuth/magic-link redirect and a session-restore failure (offline,
  // CDN blocked, project unreachable) - all of which used to look identical to
  // "you are simply signed out".
  const banner = card.querySelector("#authBanner");
  const redirectError = readAuthRedirectError();
  const initError = getLastAuthError();
  if (redirectError || initError) {
    banner.hidden = false;
    banner.textContent = redirectError
      ? `Sign-in was rejected: ${redirectError}`
      : `Couldn't reach the account service: ${initError}. Check your connection - your data is safe.`;
  }

  card.querySelector("#pwForgot").addEventListener("click", async () => {
    const typed = card.querySelector("#pwUser").value.trim();
    const email = typed.includes("@") ? typed : card.querySelector("#signinEmail").value.trim();
    if (!email.includes("@")) {
      pwMessage.textContent = "Enter your email address (not just a username) to reset.";
      card.querySelector("#signinEmail").focus();
      return;
    }
    pwMessage.textContent = "Sending reset link...";
    try {
      await sendPasswordReset(email);
      pwMessage.textContent = `Reset link sent to ${email}. Check spam if it isn't there in a minute.`;
    } catch (err) {
      pwMessage.textContent = `Couldn't send reset: ${err.message || err}`;
    }
  });
  card.querySelector("#localSignin").addEventListener("click", async () => {
    message.textContent = "Starting local session...";
    const session = await signInLocal({
      name: card.querySelector("#localName").value.trim() || "You",
      email: card.querySelector("#localEmail").value.trim() || "local@trackerz.app",
    });
    message.textContent = `Local session ready for ${session.user.email}.`;
  });
  // Don't offer a button that cannot work. Both providers are disabled on this
  // project, so "Continue with Google" could only ever eject the user to a
  // Supabase error page - which is exactly what the owner reported.
  getEnabledProviders().then((external) => {
    if (!external) return; // couldn't tell; leave the buttons alone
    const row = card.querySelector(".oauth-row");
    let disabledCount = 0;
    card.querySelectorAll(".oauth-button").forEach((btn) => {
      if (external[btn.dataset.provider] === false) {
        btn.remove();
        disabledCount += 1;
      }
    });
    if (row && !row.querySelector(".oauth-button")) {
      row.previousElementSibling?.remove(); // the "or use another method" divider
      row.innerHTML = `<p class="muted small">Social sign-in isn't set up on this project${
        disabledCount ? "" : ""
      }. Use your email and password above, or enable a provider in Supabase → Authentication → Providers.</p>`;
    }
  });

  card.querySelectorAll(".oauth-button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const provider = btn.dataset.provider;
      message.textContent = `Opening ${provider}...`;
      btn.setAttribute("disabled", "");
      try {
        await signInWithProvider(provider);
      } catch (err) {
        // A disabled provider now says so in plain words on the card, rather
        // than bouncing the user to a raw Supabase error page.
        message.textContent = "";
        banner.hidden = false;
        banner.textContent = err.message || String(err);
        btn.classList.add("is-unavailable");
      } finally {
        btn.removeAttribute("disabled");
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

// Landing from a password-reset email: set the new password here. Without this
// the emailed link dropped the user on a normal page with a recovery session and
// no way to actually change anything.
function showRecoveryCard() {
  removeCard(SIGNIN_ID);
  let card = document.getElementById("trackerz-recovery-card");
  if (!card) {
    card = document.createElement("section");
    card.id = "trackerz-recovery-card";
    card.className = "auth-card signin-card";
    document.body.appendChild(card);
  }
  card.innerHTML = `
    <h2>Set a new password</h2>
    <p class="muted small">You followed a reset link. Choose a password of at least 6 characters.</p>
    <label>New password
      <input type="password" id="newPass" autocomplete="new-password" />
    </label>
    <label>Confirm
      <input type="password" id="newPass2" autocomplete="new-password" />
    </label>
    <button type="button" id="savePass" class="primary-button">Save password</button>
    <p id="recoveryMessage" class="muted small" role="status" aria-live="polite"></p>
  `;
  const msg = card.querySelector("#recoveryMessage");
  card.querySelector("#savePass").addEventListener("click", async () => {
    const a = card.querySelector("#newPass").value;
    const b = card.querySelector("#newPass2").value;
    if (a.length < 6) { msg.textContent = "At least 6 characters."; return; }
    if (a !== b) { msg.textContent = "The two passwords don't match."; return; }
    msg.textContent = "Saving...";
    try {
      await updatePassword(a);
      msg.textContent = "Password updated. Loading your account...";
      try { history.replaceState(null, "", location.pathname); } catch { /* non-browser */ }
      location.reload();
    } catch (err) {
      msg.textContent = `Couldn't update: ${err.message || err}`;
    }
  });
}

// The account control IS the existing topbar Settings link, collapsed to a
// compact avatar (the user's initial) - no sprawling email in the bar. Account
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
