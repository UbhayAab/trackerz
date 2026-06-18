import { mountAuthGate } from "../ui/auth-gate.js";
import { applyPrivacyMode } from "../services/privacy-mode.js";

export function bootWithAuth(onReady) {
  applyPrivacyMode(); // honor the persisted privacy toggle on every page
  let started = false;
  mountAuthGate({
    onReady(session) {
      if (started) return;
      started = true;
      onReady(session);
    },
  });
}
