import { mountAuthGate } from "../ui/auth-gate.js";
import { applyPrivacyMode } from "../services/privacy-mode.js";
import { initTheme } from "../ui/theme.js";

export function bootWithAuth(onReady) {
  applyPrivacyMode(); // honor the persisted privacy toggle on every page
  initTheme();        // apply light/dark + mount the topbar toggle on every page
  let started = false;
  mountAuthGate({
    onReady(session) {
      if (started) return;
      started = true;
      // Fire-and-forget device syncs. All are hard no-ops in a browser (no bridge)
      // and never block or break boot:
      //  - Payment notifications: log spend from GPay/PhonePe/bank alerts, whatever
      //    the payment origin (this is the primary passive spend capture).
      //  - SMS: backstop for card/bank/laptop payments the notification misses.
      //  - Health Connect: pull watch sleep + steps (throttled to once per 6h).
      import("../services/notification-capture.js")
        .then((m) => {
          m.initNotificationCapture();
          // Re-drain each time the app regains focus - right after the user returns
          // from paying in another app, their new spend is logged immediately.
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && m.isAutoCaptureEnabled()) m.drainAndCapture().catch(() => {});
          });
        })
        .catch(() => {});
      import("../services/sms-capture.js")
        .then((m) => m.initSmsAutoCapture())
        .catch(() => {});
      import("../services/health-sync.js")
        .then((m) => m.initHealthAutoSync())
        .catch(() => {});
      onReady(session);
    },
  });
}
