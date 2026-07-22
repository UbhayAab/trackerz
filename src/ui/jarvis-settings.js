// Settings → Jarvis card. Binds the real delivery controls that replaced the
// old decorative "nightly summary" toggle: master switch (profiles.briefing_enabled,
// still #nightlySummaryToggle for the ui-contract), email + push channel toggles,
// browser push permission/subscription, and "Brief me now".

import { fetchJarvisProfile, updateJarvisPrefs, runJarvisNow } from "../services/jarvis.js";
import { enablePush, disablePush, getPushState, pushSupported, showLocalTestNotification } from "../services/push.js";
import { showToast } from "./toast.js";

function setStatus(el, text, ok = true) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", ok);
}

// Every failure the push path can return, in words the owner can act on.
function pushFailureText(res) {
  const detail = res?.error ? ` (${res.error})` : "";
  switch (res?.reason) {
    case "denied":
      return "Blocked for this site. Allow notifications in the browser's site settings, then press Enable again.";
    case "default":
      return "Permission dismissed — nothing was enabled. Press Enable again and choose Allow.";
    case "unsupported_install_first":
      return "This browser can't do Web Push here. On iPhone, add Trackerz to the Home Screen and open it from there.";
    case "unsupported":
      return "This browser doesn't support Web Push.";
    case "no_service_worker":
      return "The service worker didn't start, so no subscription could be created. Reload the page and try again.";
    case "subscribe_failed":
      return `The browser refused the push subscription${detail}.`;
    case "save_failed":
      return `Subscribed on this device but the endpoint could NOT be saved${detail} — the server still can't reach you. Try again.`;
    case "unsubscribe_failed":
      return `Couldn't unsubscribe this device${detail}.`;
    case "show_failed":
      return `The notification failed to display${detail}.`;
    default:
      return `Notifications failed${detail}.`;
  }
}

// Honest rendering: when we can't reach the service worker the subscription is
// UNKNOWN, not off — say so rather than showing a confident empty checkbox.
function renderPushState(state, { line, toggle, profile }) {
  if (toggle) toggle.indeterminate = false;
  if (!pushSupported()) {
    if (toggle) { toggle.checked = false; toggle.disabled = true; }
    setStatus(line, "Notifications on this device: not supported by this browser. On iPhone, install to the Home Screen first.");
    return;
  }
  if (!state.ready) {
    if (toggle) { toggle.checked = false; toggle.indeterminate = true; }
    setStatus(line, "Notifications on this device: — (couldn't reach the service worker; reload the page)");
    return;
  }
  if (toggle) toggle.disabled = false;
  const prefOn = profile?.push_enabled !== false;
  if (state.permission === "denied") {
    if (toggle) toggle.checked = false;
    setStatus(line, "Notifications on this device: blocked in browser settings. Allow them for this site, then press Enable.");
    return;
  }
  if (state.subscribed) {
    if (toggle) toggle.checked = prefOn;
    let host = "—";
    try { if (state.endpoint) host = new URL(state.endpoint).host; } catch { /* keep the em-dash */ }
    setStatus(line, prefOn
      ? `Notifications on this device: on (subscribed via ${host}).`
      : `Notifications on this device: subscribed via ${host}, but delivery is paused by the toggle above.`);
    return;
  }
  if (toggle) toggle.checked = false;
  setStatus(line, state.permission === "granted"
    ? "Notifications on this device: allowed but not subscribed yet — press Enable notifications."
    : "Notifications on this device: off — press Enable notifications.");
}

export async function bindJarvisCard() {
  const master = document.querySelector("#nightlySummaryToggle");
  const emailToggle = document.querySelector("#emailBriefToggle");
  const pushToggle = document.querySelector("#pushBriefToggle");
  const briefNowBtn = document.querySelector("#briefNowBtn");
  const enablePushBtn = document.querySelector("#enablePushBtn");
  const testPushBtn = document.querySelector("#testPushBtn");
  const pushLine = document.querySelector("#pushStatus");
  const status = document.querySelector("#scheduleStatus");
  const detail = document.querySelector("#jarvisDetail");
  if (!master) return;

  let profile = null;
  try {
    profile = await fetchJarvisProfile();
  } catch (err) {
    // Bail out loudly — the card's controls all write to profiles, and the push
    // status line must not sit on "checking…" forever.
    setStatus(status, "offline", false);
    setStatus(pushLine, `Couldn't load delivery settings: ${err?.message || err}`, false);
    return;
  }

  master.checked = profile.briefing_enabled !== false;
  if (emailToggle) emailToggle.checked = profile.email_brief !== false;
  setStatus(status, master.checked ? "scheduled" : "paused");

  // Push state reflects BOTH the profile flag and this browser's subscription.
  const refreshPush = async () => {
    const state = await getPushState();
    renderPushState(state, { line: pushLine, toggle: pushToggle, profile });
    if (enablePushBtn) {
      enablePushBtn.hidden = state.ready && state.subscribed && profile.push_enabled !== false;
    }
    if (testPushBtn) testPushBtn.disabled = !(state.ready && state.permission === "granted");
    return state;
  };
  await refreshPush();

  master.addEventListener("change", async () => {
    setStatus(status, master.checked ? "scheduled" : "paused");
    try { await updateJarvisPrefs({ briefing_enabled: master.checked }); }
    catch { setStatus(status, "save failed", false); }
  });

  emailToggle?.addEventListener("change", async () => {
    try { await updateJarvisPrefs({ email_brief: emailToggle.checked }); }
    catch { setStatus(status, "save failed", false); }
  });

  // The real entry point. A checkbox can't be trusted to trigger the permission
  // prompt (it never did — that is why push_subscriptions was empty), so this is
  // an explicit action that asks, subscribes, saves, and reports what happened.
  const turnOnPush = async (btn) => {
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Enabling…"; }
    let failure = null;
    try {
      const res = await enablePush();
      if (!res.ok) {
        failure = pushFailureText(res);
        showToast(failure, { kind: "error", duration: 6000 });
        return false;
      }
      await updateJarvisPrefs({ push_enabled: true });
      profile.push_enabled = true;
      showToast("Notifications enabled on this device.", { kind: "success" });
      return true;
    } catch (err) {
      failure = `Couldn't save the notification preference: ${err?.message || err}`;
      showToast(failure, { kind: "error", duration: 6000 });
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      // refreshPush() re-renders the status line from the BROWSER's view, which
      // knows nothing about a failed server save — it would happily overwrite
      // "couldn't reach the server" with "on (subscribed)". So refresh first,
      // then put the failure back on top and keep the Enable button available.
      await refreshPush();
      if (failure) {
        setStatus(pushLine, failure, false);
        if (enablePushBtn) enablePushBtn.hidden = false;
      }
    }
  };

  enablePushBtn?.addEventListener("click", () => turnOnPush(enablePushBtn));

  testPushBtn?.addEventListener("click", async () => {
    testPushBtn.disabled = true;
    try {
      const res = await showLocalTestNotification();
      if (!res.ok) {
        setStatus(pushLine, pushFailureText(res), false);
        showToast(pushFailureText(res), { kind: "error", duration: 6000 });
      } else {
        showToast("Test notification shown (local only — not a server push).", { kind: "success" });
      }
    } finally {
      testPushBtn.disabled = false;
      await refreshPush();
    }
  });

  pushToggle?.addEventListener("change", async () => {
    try {
      if (pushToggle.checked) {
        await turnOnPush(enablePushBtn);
      } else {
        const res = await disablePush();
        if (!res.ok) {
          setStatus(pushLine, pushFailureText(res), false);
          showToast(pushFailureText(res), { kind: "error", duration: 6000 });
        }
        await updateJarvisPrefs({ push_enabled: false });
        profile.push_enabled = false;
        await refreshPush();
      }
    } catch (err) {
      const msg = `Push preference not saved: ${err?.message || err}`;
      setStatus(pushLine, msg, false);
      showToast(msg, { kind: "error", duration: 6000 });
      setStatus(status, "push failed", false);
      await refreshPush();
    }
  });

  briefNowBtn?.addEventListener("click", async () => {
    briefNowBtn.disabled = true;
    const label = briefNowBtn.textContent;
    briefNowBtn.textContent = "Composing…";
    try {
      const res = await runJarvisNow("morning", { force: true });
      const r = res?.results?.[0] || {};
      const voice = r.voice ? ` (voice: ${r.voice})` : "";
      if (detail) detail.textContent = `Brief regenerated and delivered${voice}. Check Home, your inbox, and notifications.`;
    } catch (err) {
      if (detail) detail.textContent = `Brief failed: ${err?.message || err}`;
    } finally {
      briefNowBtn.disabled = false;
      briefNowBtn.textContent = label;
    }
  });
}
