// CONNECTED CALENDARS - the Settings panel for Google Calendar sync.
//
// DOM and event binding only (the src/ui/ layer rule): every fact on screen
// comes from src/services/gcal.js, which is the only module allowed to talk to
// the edge function.
//
// THE ONE THING THIS PANEL EXISTS TO PREVENT
//
// A broken OAuth grant does not render as an error. It renders as a calendar
// with nothing in it, which looks exactly like a calendar with nothing in it.
// Google's OAuth "Testing" mode revokes every refresh token after seven days,
// and the app would go on showing a clean, empty, confident screen with a missed
// deadline as the payload. So:
//
//   - `sync_broken_since` renders as a LOUD banner with the reason in words and
//     how many days it has been broken, not a muted pill.
//   - "Last sync" is the last SUCCESSFUL sync. It never moves on a failure.
//   - A count we could not read renders as "-", never as 0.
//   - With no OAuth client configured the panel says exactly which two secrets
//     are missing, in the server's own words.
//
// It mounts into #gcalPanel if that element exists and no-ops otherwise, so
// adding the markup to settings.html is what turns it on.

import {
  fetchGcalStatus,
  startGcalConnect,
  syncGcalNow,
  disconnectGcal,
  gcalHealth,
  gcalChannelState,
  gcalSetupMessage,
  readConnectOutcome,
} from "../services/gcal.js";
import { showToast } from "./toast.js";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * A metric that is allowed to be unknown. `0` and "we could not count it" must
 * never render identically - that confusion is the house disease.
 */
function fmtMetric(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${Number(value)}${suffix}`;
}

function fmtWhen(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(t).toLocaleString();
}

export function mountGcalPanel() {
  const panel = document.getElementById("gcalPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Connected calendars</p>
        <h2>Google Calendar</h2>
      </div>
      <span id="gcalPill" class="status-pill muted">checking…</span>
    </div>
    <div id="gcalBanner" class="gcal-banner" hidden></div>
    <div id="gcalAccounts" class="gcal-accounts"></div>
    <div class="data-actions">
      <button id="gcalConnectBtn" class="primary-button" type="button">Connect Google Calendar</button>
      <button id="gcalSyncBtn" class="secondary-button" type="button">Sync now</button>
    </div>
    <p id="gcalResult" class="agent-detail" aria-live="polite"></p>
    <p class="agent-detail">Deno writes your reminders into a calendar it creates called "Deno" and touches nothing else - the Google permission it asks for cannot reach your real calendars at all. Your other calendars are pulled in read-only, and nothing is ever written back to them.</p>
  `;

  const pill = panel.querySelector("#gcalPill");
  const banner = panel.querySelector("#gcalBanner");
  const accountsEl = panel.querySelector("#gcalAccounts");
  const connectBtn = panel.querySelector("#gcalConnectBtn");
  const syncBtn = panel.querySelector("#gcalSyncBtn");
  const resultEl = panel.querySelector("#gcalResult");

  function setResult(text, isError = false) {
    resultEl.textContent = text || "";
    resultEl.classList.toggle("gcal-error-text", Boolean(isError));
  }

  /**
   * The loud one. Not a toast (they disappear), not a pill (too quiet): a
   * persistent block with the reason and the fix, because the whole failure mode
   * is silence.
   */
  function renderError(title, detail, action = "") {
    banner.hidden = false;
    banner.className = "gcal-banner gcal-banner-bad";
    banner.innerHTML = `<strong>${esc(title)}</strong><span>${esc(detail)}</span>${action ? `<span class="gcal-banner-fix">${esc(action)}</span>` : ""}`;
  }

  function renderNotice(title, detail) {
    banner.hidden = false;
    banner.className = "gcal-banner gcal-banner-info";
    banner.innerHTML = `<strong>${esc(title)}</strong><span>${esc(detail)}</span>`;
  }

  function clearBanner() {
    banner.hidden = true;
    banner.innerHTML = "";
  }

  function renderAccount(account) {
    const health = gcalHealth(account);
    const channel = gcalChannelState(account);
    return `
      <div class="gcal-account${health.broken ? " gcal-account-bad" : ""}">
        <div class="account-row">
          <span class="muted small">Account</span>
          <strong>${esc(account.external_account_email || "(unknown account)")}</strong>
        </div>
        <div class="account-row">
          <span class="muted small">Writes to</span>
          <span>${esc(account.calendar_summary || "Deno")} (a calendar Deno created)</span>
        </div>
        <div class="account-row">
          <span class="muted small">Last successful sync</span>
          <span>${esc(fmtWhen(account.last_sync_at))}</span>
        </div>
        <div class="account-row">
          <span class="muted small">Reminders synced</span>
          <span>${fmtMetric(account.linked_events)}</span>
        </div>
        <div class="account-row">
          <span class="muted small">Mirrored events</span>
          <span>${account.can_mirror ? fmtMetric(account.mirrored_events) : "read access not granted"}</span>
        </div>
        <div class="account-row">
          <span class="muted small">Live updates</span>
          <span>${esc(channel.label)}</span>
        </div>
        ${(account.count_errors || []).length ? `<p class="gcal-error-text small">Some counts could not be read: ${esc((account.count_errors || []).join("; "))}</p>` : ""}
        <div class="data-actions">
          <button class="secondary-button danger" type="button" data-gcal-disconnect="${esc(account.id)}">Disconnect</button>
        </div>
      </div>
    `;
  }

  async function refresh() {
    const result = await fetchGcalStatus();

    // A failed status read is itself a failure worth naming. Rendering an empty
    // panel here would be the same lie the whole panel exists to prevent.
    if (!result.ok) {
      pill.textContent = "unavailable";
      pill.classList.add("muted");
      accountsEl.innerHTML = "";
      renderError(
        "Could not check your connected calendars",
        result.meta?.detail || result.message || result.kind,
        result.retryable ? "This usually clears on its own - press Sync now to retry." : "",
      );
      connectBtn.disabled = true;
      syncBtn.disabled = true;
      return null;
    }

    const status = result.value;
    const accounts = Array.isArray(status.accounts) ? status.accounts : [];

    // Accounts render FIRST and unconditionally, before any "not set up yet"
    // branch. An earlier version returned early when the OAuth client was
    // missing, which meant an account whose sync had been dead for eleven days
    // rendered as a tidy "setup needed" notice with the breakage nowhere on
    // screen. That is the precise failure this panel exists to prevent, rebuilt
    // one level up.
    accountsEl.innerHTML = accounts.map(renderAccount).join("");
    for (const btn of accountsEl.querySelectorAll("[data-gcal-disconnect]")) {
      btn.addEventListener("click", () => disconnect(btn.dataset.gcalDisconnect));
    }

    connectBtn.disabled = !status.configured;
    connectBtn.title = status.configured ? "" : "Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the Supabase project";
    connectBtn.textContent = accounts.length ? "Reconnect" : "Connect Google Calendar";
    syncBtn.disabled = !status.configured || !accounts.length;

    // ---- THE LOUD BANNER, and it outranks everything else on this panel.
    const broken = accounts.map((a) => ({ account: a, health: gcalHealth(a) })).filter((x) => x.health.broken);
    if (broken.length) {
      pill.textContent = "sync broken";
      pill.classList.remove("muted");
      const first = broken[0];
      renderError(
        `Google Calendar sync has been broken for ${first.health.days} day${first.health.days === 1 ? "" : "s"}`,
        first.health.reason,
        first.health.needsReauth
          ? "Press Reconnect and sign in to Google again. Until you do, nothing you add here reaches your calendar and nothing you add there reaches here."
          : "Press Sync now. If it keeps failing, press Reconnect.",
      );
      if (!status.configured) {
        banner.innerHTML += `<span class="gcal-banner-fix">${esc(gcalSetupMessage(status))}</span>`;
      }
      return status;
    }

    // ---- the OAuth client does not exist yet.
    if (!status.configured) {
      pill.textContent = "setup needed";
      pill.classList.add("muted");
      renderNotice("Not set up yet", gcalSetupMessage(status));
      banner.innerHTML += `<span class="gcal-banner-fix">Everything else is built, deployed and tested. The only missing piece is the owner's Google OAuth client: create one, then set the two secrets. The redirect URI to paste into Google is <code>${esc(status.redirect_uri || "")}</code>.</span>`;
      return status;
    }

    if (!accounts.length) {
      pill.textContent = "not connected";
      pill.classList.add("muted");
      renderNotice("No calendar connected", "Connect your Google account and Deno will keep your reminders in a calendar of its own.");
      return status;
    }

    pill.textContent = "connected";
    pill.classList.remove("muted");
    clearBanner();
    return status;
  }

  async function connect() {
    connectBtn.disabled = true;
    setResult("Asking Google…");
    const result = await startGcalConnect();
    connectBtn.disabled = false;
    if (!result.ok) {
      setResult(result.meta?.payload?.message || result.meta?.detail || result.message || "Could not start the Google sign-in.", true);
      return;
    }
    const url = result.value?.url;
    if (!url) {
      setResult("Google returned no sign-in URL.", true);
      return;
    }

    // GOOGLE REFUSES OAUTH INSIDE AN EMBEDDED WEBVIEW. Signing in from a
    // Capacitor WebView returns `disallowed_useragent` (403) with a Google-branded
    // error page and no way forward, and this app's own surface on the owner's
    // phone IS a WebView. So on native the consent page is handed to the SYSTEM
    // browser; the callback comes back to the edge function, which redirects to
    // the app URL, so nothing about the return leg changes.
    //
    // The link is rendered EITHER WAY and left on screen. `window.open` can be
    // blocked, and a blocked popup with an encouraging "Opening Google…" beside
    // it is a dead end with no visible cause - which is the failure shape this
    // panel exists to prevent. A tappable link always survives.
    const native = Boolean(globalThis.Capacitor?.isNativePlatform?.());
    if (resultEl) {
      resultEl.classList.remove("gcal-error-text");
      resultEl.innerHTML = `Opening Google…  <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open the sign-in page</a>`
        + (native ? ` <small>(it opens in your browser, not inside the app - Google does not allow sign-in inside an app's own web view)</small>` : "");
    }
    if (native) {
      try {
        globalThis.open(url, "_blank");
      } catch (err) {
        // Named, not swallowed: if the WebView refuses to hand the page over,
        // that is the reason the link below is the only way through.
        setResult(`This app could not open your browser (${err?.message || err}). Use the sign-in link instead.`, true);
        if (resultEl) {
          resultEl.innerHTML += ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open the sign-in page</a>`;
        }
      }
      return;
    }
    location.href = url;
  }

  async function sync() {
    syncBtn.disabled = true;
    setResult("Syncing…");
    const result = await syncGcalNow();
    syncBtn.disabled = false;
    if (!result.ok) {
      setResult(result.meta?.payload?.message || result.meta?.detail || result.message || "Sync failed.", true);
      await refresh();
      return;
    }
    // Report exactly what happened, including zeros. A run that changed nothing
    // says so; it does not claim success in the abstract.
    const runs = Array.isArray(result.value?.results) ? result.value.results : [];
    const bits = [];
    for (const run of runs) {
      if (run.ok === false) { bits.push(`failed: ${run.error}`); continue; }
      const p = run.push || {};
      const q = run.pull || {};
      bits.push(`pulled ${q.ownPulled ?? 0}, applied ${q.applied ?? 0}, mirrored ${q.mirrored ?? 0}; pushed ${(p.created ?? 0) + (p.updated ?? 0)}, unchanged ${p.noop ?? 0}`);
      for (const note of [...(q.notes || []), ...(p.notes || [])]) bits.push(note);
    }
    setResult(bits.length ? bits.join(" · ") : "Nothing to sync.", runs.some((r) => r.ok === false));
    await refresh();
  }

  async function disconnect(accountId) {
    setResult("Disconnecting…");
    const result = await disconnectGcal(accountId);
    if (!result.ok) {
      setResult(result.meta?.payload?.message || result.message || "Could not disconnect.", true);
      return;
    }
    const notes = result.value?.notes || [];
    setResult(notes.length ? `Disconnected. ${notes.join(" ")}` : "Disconnected.", notes.length > 0);
    await refresh();
  }

  connectBtn.addEventListener("click", connect);
  syncBtn.addEventListener("click", sync);

  // The OAuth callback bounces back here with ?gcal=connected|error.
  const outcome = readConnectOutcome();
  if (outcome && outcome.state === "connected") {
    showToast(`Google Calendar connected (${outcome.account})`, { kind: "success" });
    setResult(outcome.note || "");
  } else if (outcome && outcome.state === "error") {
    renderError("Could not connect Google Calendar", outcome.reason || "Google did not say why.", "Try Connect again.");
  }

  refresh();
}
