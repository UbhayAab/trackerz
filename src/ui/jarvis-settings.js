// Settings → Jarvis card. Binds the real delivery controls that replaced the
// old decorative "nightly summary" toggle: master switch (profiles.briefing_enabled,
// still #nightlySummaryToggle for the ui-contract), email + push channel toggles,
// browser push permission/subscription, and "Brief me now".

import { fetchJarvisProfile, updateJarvisPrefs, runJarvisNow } from "../services/jarvis.js";
import { enablePush, disablePush, getPushState, pushSupported } from "../services/push.js";

function setStatus(el, text, ok = true) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", ok);
}

export async function bindJarvisCard() {
  const master = document.querySelector("#nightlySummaryToggle");
  const emailToggle = document.querySelector("#emailBriefToggle");
  const pushToggle = document.querySelector("#pushBriefToggle");
  const briefNowBtn = document.querySelector("#briefNowBtn");
  const status = document.querySelector("#scheduleStatus");
  const detail = document.querySelector("#jarvisDetail");
  if (!master) return;

  let profile = null;
  try {
    profile = await fetchJarvisProfile();
  } catch {
    setStatus(status, "offline", false);
    return;
  }

  master.checked = profile.briefing_enabled !== false;
  if (emailToggle) emailToggle.checked = profile.email_brief !== false;
  setStatus(status, master.checked ? "scheduled" : "paused");

  // Push toggle reflects BOTH the profile flag and this browser's subscription.
  const pushState = await getPushState();
  if (pushToggle) {
    if (!pushSupported()) {
      pushToggle.checked = false;
      pushToggle.disabled = true;
    } else {
      pushToggle.checked = profile.push_enabled !== false && pushState.subscribed;
    }
  }
  if (detail && pushState.permission === "denied") {
    detail.textContent = "Notifications are blocked for this site — enable them in the browser's site settings, then flip the toggle.";
  }

  master.addEventListener("change", async () => {
    setStatus(status, master.checked ? "scheduled" : "paused");
    try { await updateJarvisPrefs({ briefing_enabled: master.checked }); }
    catch { setStatus(status, "save failed", false); }
  });

  emailToggle?.addEventListener("change", async () => {
    try { await updateJarvisPrefs({ email_brief: emailToggle.checked }); }
    catch { setStatus(status, "save failed", false); }
  });

  pushToggle?.addEventListener("change", async () => {
    try {
      if (pushToggle.checked) {
        const res = await enablePush();
        if (!res.ok) {
          pushToggle.checked = false;
          if (detail) {
            detail.textContent = res.reason === "denied"
              ? "Notifications are blocked for this site — allow them in the browser's site settings first."
              : "This browser doesn't support Web Push (on iPhone, install the app to the home screen first).";
          }
          return;
        }
        await updateJarvisPrefs({ push_enabled: true });
        if (detail) detail.textContent = "This device will get the morning brief and evening nudge.";
      } else {
        await disablePush();
        await updateJarvisPrefs({ push_enabled: false });
      }
    } catch {
      pushToggle.checked = false;
      setStatus(status, "push failed", false);
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
