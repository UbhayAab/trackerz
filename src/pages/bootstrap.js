import { mountAuthGate } from "../ui/auth-gate.js";
import { applyPrivacyMode } from "../services/privacy-mode.js";
import { initTheme } from "../ui/theme.js";
import { Err, Ok, classify } from "../../lib/failure.mjs";

// DEVICE SYNC OUTCOMES - previously thrown away.
//
// The three background syncs below used to start with `.catch(() => {})`, which
// tests/fixtures/swallow-allowlist.json had already flagged as a REAL GAP and
// deferred: "auto-capture can silently never start and the Settings toggles
// still read as if it did".
//
// The live database says it was not hypothetical. Passive spend capture is the
// feature the owner asked for in his own words ("when I pay it should get
// locked in"), and over its whole life it has produced ONE capture, on
// 2026-07-28. `ledger_entries` holds 187 rows from statement imports (last one
// 2026-06-29) and 17 hand-typed rows, and nothing else - no source has ever
// written a payment row automatically. `sleep_sessions` has three rows, ever.
//
// None of that proves the syncs are broken: on a browser they are correct
// no-ops, and on the phone the permissions may simply never have been granted.
// That is exactly the point. A silent catch made "no bridge, working as
// designed", "never granted permission" and "threw on startup" produce
// identical evidence: nothing. So record the outcome instead of discarding it,
// and let the diagnostics page say which one actually happened.
const deviceSyncResults = new Map();

/** Every device sync's last start outcome, for the diagnostics page. */
export function deviceSyncStatuses() {
  return [...deviceSyncResults.entries()].map(([name, result]) => ({ name, result }));
}

/**
 * Start one background sync and REMEMBER how it went.
 *
 * `load` is the dynamic import; `start` runs the module's init. A failure in
 * either is recorded as an Err with a named source and never rethrown, because
 * a dead microphone bridge must not stop the app from booting.
 */
async function startDeviceSync(name, load, start) {
  try {
    const mod = await load();
    const detail = await start(mod);
    deviceSyncResults.set(name, Ok(detail ?? true, { source: name }));
    return mod;
  } catch (e) {
    deviceSyncResults.set(name, Err(classify(e), e, { source: name }));
    return null;
  }
}

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
      void startDeviceSync(
        "payment notifications",
        () => import("../services/notification-capture.js"),
        (m) => {
          m.initNotificationCapture();
          // Re-drain each time the app regains focus - right after the user returns
          // from paying in another app, their new spend is logged immediately.
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible" || !m.isAutoCaptureEnabled()) return;
            m.drainAndCapture().catch((e) => {
              // A drain that fails on return-from-payment is precisely the moment
              // a spend goes unrecorded, so it is recorded as a failure rather
              // than dropped.
              deviceSyncResults.set("payment notifications", Err(classify(e), e, { source: "payment notifications" }));
            });
          });
        },
      );
      void startDeviceSync(
        "bank SMS",
        () => import("../services/sms-capture.js"),
        (m) => m.initSmsAutoCapture(),
      );
      void startDeviceSync(
        "watch health data",
        () => import("../services/health-sync.js"),
        (m) => m.initHealthAutoSync(),
      );
      onReady(session);
    },
  });
}
