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
      // Fire-and-forget: on the Android app, with SMS auto-capture switched on and
      // permission granted, pull any new bank/UPI transaction SMS into the ledger.
      // Hard no-op in a browser (no bridge) and never blocks or breaks boot.
      import("../services/sms-capture.js")
        .then((m) => m.initSmsAutoCapture())
        .catch(() => {});
      onReady(session);
    },
  });
}
