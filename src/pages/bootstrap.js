import { mountAuthGate } from "../ui/auth-gate.js";

export function bootWithAuth(onReady) {
  let started = false;
  mountAuthGate({
    onReady(session) {
      if (started) return;
      started = true;
      onReady(session);
    },
  });
}
