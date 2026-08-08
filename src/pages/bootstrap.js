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
// A sync that DECLINED to start is not a sync that started.
//
// initHealthAutoSync returns `{started: false, reason}` instead of throwing, so
// "Health Connect permission was never granted" was being stored as an Ok and
// the diagnostics page listed watch health data as fine. It is not fine:
// sleep_sessions has three rows ever, the newest 2026-07-30, and not one of them
// came from Health Connect - the source that was supposed to make sleep
// automatic has never written a single row, and nothing said so.
//
// "browser" is the one honest not-started: there is no bridge to permit in a
// browser, and calling that a failure would put a permanent red mark on the web
// app for a feature it cannot have. Everything else - no_permission, a reason
// string from a thrown init - is a real gap the user can act on.
function classifyStart(detail) {
  if (!detail || typeof detail !== "object" || detail.started !== false) return null;
  const reason = String(detail.reason || "unknown");
  if (reason === "browser" || reason === "recent") return null;
  return reason;
}

async function startDeviceSync(name, load, start) {
  try {
    const mod = await load();
    const detail = await start(mod);
    const declined = classifyStart(detail);
    // no_permission is `unauthorized` (the OS refused, and granting it is the
    // fix); anything else is `unknown`, which this codebase defines as "never
    // silently treat as ok" - exactly the right default for a reason we have not
    // seen before.
    deviceSyncResults.set(name, declined
      ? Err(declined === "no_permission" ? "unauthorized" : "unknown",
          new Error(`did not start: ${declined}`), { source: name, detail })
      : Ok(detail ?? true, { source: name }));
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
