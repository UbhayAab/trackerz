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
      // Fire-and-forget device syncs. Both are hard no-ops in a browser (no bridge)
      // and never block or break boot:
      //  - SMS auto-capture: pull new bank/UPI transaction SMS into the ledger.
      //  - Health Connect: pull watch sleep + steps (throttled to once per 6h).
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
