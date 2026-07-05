import { updateState } from "../state/app-state.js";
import { fetchBriefingEnabled, setBriefingEnabled } from "../services/supabase-data.js";
import { pushSupported, getPushState, enablePush, disablePush, sendTestPush, runMyBriefingNow } from "../services/push.js";

export function bindNightlySchedule() {
  const toggle = document.querySelector("#nightlySummaryToggle");
  const status = document.querySelector("#scheduleStatus");
  if (!toggle || !status) return;

  // Reflect + persist the server-side gate: the nightly cron only generates and
  // pushes briefings for users with profiles.briefing_enabled.
  fetchBriefingEnabled()
    .then((enabled) => {
      toggle.checked = enabled;
      status.textContent = enabled ? "enabled" : "paused";
    })
    .catch(() => null);

  toggle.addEventListener("change", () => {
    status.textContent = toggle.checked ? "enabled" : "paused";
    setBriefingEnabled(toggle.checked).catch(() => null);
    updateState((state) => {
      state.parseLog.unshift(toggle.checked ? "Proactive briefings enabled." : "Proactive briefings paused.");
    });
  });

  document.querySelector("#autopilotToggle")?.addEventListener("change", (event) => {
    updateState((state) => {
      state.parseLog.unshift(event.target.checked ? "Autopilot enabled for safe rows." : "Autopilot disabled. Review-first mode active.");
    });
  });

  bindPushControls();
}

function bindPushControls() {
  const pushToggle = document.querySelector("#pushToggle");
  const pushStatus = document.querySelector("#pushStatus");
  const testBtn = document.querySelector("#pushTestBtn");
  const nowBtn = document.querySelector("#briefingNowBtn");
  if (!pushToggle || !pushStatus) return;

  const say = (msg) => { pushStatus.textContent = msg; };

  if (!pushSupported()) {
    pushToggle.disabled = true;
    say("Push isn't supported in this browser. On iPhone: add Trackerz to the Home Screen, then enable here.");
    return;
  }

  getPushState().then((state) => {
    pushToggle.checked = state === "subscribed";
    if (state === "denied") {
      pushToggle.disabled = true;
      say("Notifications are blocked for this site — re-allow them in browser settings, then reload.");
    }
  }).catch(() => null);

  pushToggle.addEventListener("change", async () => {
    try {
      if (pushToggle.checked) {
        say("Registering this device…");
        await enablePush();
        say("This device will receive briefing notifications.");
      } else {
        await disablePush();
        say("Push disabled on this device.");
      }
    } catch (err) {
      pushToggle.checked = false;
      say(`Push setup failed: ${err?.message || err}`);
    }
  });

  testBtn?.addEventListener("click", async () => {
    try {
      say("Sending test notification…");
      const r = await sendTestPush();
      say(r?.sent ? `Test sent to ${r.sent} device${r.sent === 1 ? "" : "s"} — check your notifications.`
        : `No device received it (devices: ${r?.devices ?? 0}${r?.errors?.length ? `, error: ${r.errors[0]}` : ""}). Enable push above first.`);
    } catch (err) {
      say(`Test failed: ${err?.message || err}`);
    }
  });

  nowBtn?.addEventListener("click", async () => {
    try {
      say("Computing your briefing…");
      const r = await runMyBriefingNow();
      say(r?.body ? `Briefing generated: ${r.body}` : `Briefing run failed: ${r?.error || "unknown"}`);
    } catch (err) {
      say(`Briefing run failed: ${err?.message || err}`);
    }
  });
}
