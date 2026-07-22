// Settings-page panel for Health Connect sync.
//
// DOM + event binding only (src/ui/ layer rule): every fact it shows comes from
// src/services/health-sync.js, which is the only module allowed to touch the
// native bridge or the database.
//
// The panel is built to be truthful in a browser. On the GitHub Pages PWA there
// is no native bridge, so it renders a plain "this needs the Android app" state
// with the buttons disabled - it does not show a fake "connected" or invent a
// last-sync time.
//
// It mounts into #healthPanel if that element exists, and no-ops otherwise, so
// adding the markup to settings.html is what turns it on. Nothing here runs
// unless the container is present.
//
// UNTESTED ON HARDWARE. The browser state is what you can see today; the
// connected/synced states have never been rendered against real device data.

import {
  availability,
  requestPermissions,
  checkPermissions,
  syncAll,
  isNativeHealthAvailable,
} from "../services/health-sync.js";

const LAST_SYNC_KEY = "trackerz.health.lastSync";

function readLastSync() {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_SYNC_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLastSync(record) {
  try {
    globalThis.localStorage?.setItem(LAST_SYNC_KEY, JSON.stringify(record));
  } catch {
    /* private-mode / storage-full: last-sync display is best-effort, not load-bearing */
  }
}

function fmtWhen(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const d = new Date(t);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return d.toLocaleString();
}

const STATE_LABEL = {
  available: "Available",
  not_installed: "Health Connect not installed",
  update_required: "Health Connect needs an update",
  unsupported_device: "Not supported on this device",
};

/**
 * Mount the panel. Safe to call on any page - it returns immediately unless
 * #healthPanel is in the DOM.
 */
export function mountHealthPanel() {
  const panel = document.getElementById("healthPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Health Connect</p>
        <h2>Sleep &amp; activity from your phone/watch</h2>
      </div>
      <span id="healthStatePill" class="status-pill muted">checking…</span>
    </div>
    <div class="account-grid">
      <div class="account-row">
        <span class="muted small">Status</span>
        <strong id="healthStatusText">Checking…</strong>
      </div>
      <div class="account-row">
        <span class="muted small">Last sync</span>
        <span id="healthLastSync">never</span>
      </div>
      <div class="account-row">
        <span class="muted small">Last pulled</span>
        <span id="healthLastPulled">-</span>
      </div>
    </div>
    <p id="healthHint" class="muted small" style="margin:8px 0 0"></p>
    <div class="data-actions">
      <button id="healthConnectBtn" class="secondary-button" type="button">Connect</button>
      <button id="healthSyncBtn" class="primary-button" type="button">Sync now</button>
    </div>
    <p id="healthResult" class="muted small" aria-live="polite" style="margin:10px 0 0"></p>
  `;

  const pill = panel.querySelector("#healthStatePill");
  const statusText = panel.querySelector("#healthStatusText");
  const lastSyncEl = panel.querySelector("#healthLastSync");
  const lastPulledEl = panel.querySelector("#healthLastPulled");
  const hintEl = panel.querySelector("#healthHint");
  const connectBtn = panel.querySelector("#healthConnectBtn");
  const syncBtn = panel.querySelector("#healthSyncBtn");
  const resultEl = panel.querySelector("#healthResult");

  function setResult(text, isError = false) {
    resultEl.textContent = text || "";
    resultEl.style.color = isError ? "#f87171" : "";
  }

  function renderLastSync() {
    const rec = readLastSync();
    lastSyncEl.textContent = fmtWhen(rec?.at);
    if (rec?.summary) lastPulledEl.textContent = rec.summary;
  }

  // ------ browser (no bridge): say so plainly, disable actions, stop here.
  if (!isNativeHealthAvailable()) {
    pill.textContent = "Android app only";
    statusText.textContent = "Not available in the browser";
    hintEl.textContent =
      "Reading sleep, steps and heart rate needs Android Health Connect, which no browser " +
      "can access. Install the Trackerz Android app (Settings → download the APK from the " +
      "latest build) and open this page there to connect your OnePlus phone and watch.";
    connectBtn.disabled = true;
    syncBtn.disabled = true;
    connectBtn.title = "Only available in the Android app";
    syncBtn.title = "Only available in the Android app";
    renderLastSync();
    return;
  }

  // ------ native: reflect real availability + permission state.
  let permissionsOk = false;

  async function refreshAvailability() {
    setResult("");
    const a = await availability();
    const state = a?.state || "unsupported_device";
    pill.textContent = STATE_LABEL[state] || state;
    pill.classList.toggle("muted", state !== "available");

    if (state !== "available") {
      statusText.textContent = STATE_LABEL[state] || state;
      hintEl.textContent = a?.message || "";
      // Connect can still deep-link the user to fix it; sync cannot run.
      syncBtn.disabled = true;
      connectBtn.disabled = false;
      renderLastSync();
      return;
    }

    const perm = await checkPermissions();
    permissionsOk = perm?.outcome === "granted";
    statusText.textContent = permissionsOk
      ? "Connected"
      : perm?.outcome === "partial"
        ? "Some permissions granted"
        : "Not connected";
    hintEl.textContent = permissionsOk
      ? "Health Connect is connected. Sync pulls sleep and steps into your account."
      : perm?.message || "Tap Connect to grant read access to sleep and activity.";
    syncBtn.disabled = !permissionsOk && perm?.outcome !== "partial";
    connectBtn.disabled = false;
    renderLastSync();
  }

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    setResult("Opening Health Connect…");
    try {
      const res = await requestPermissions();
      setResult(res?.message || "", res?.outcome === "denied" || res?.error);
    } catch (err) {
      setResult(`Could not request permissions: ${err?.message || err}`, true);
    } finally {
      connectBtn.disabled = false;
      await refreshAvailability();
    }
  });

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    connectBtn.disabled = true;
    setResult("Syncing…");
    try {
      const res = await syncAll();
      if (!res?.supported) {
        setResult(res?.message || "Not available.", true);
        return;
      }
      // Honest reporting: show exactly what each stream did, including zeros and
      // reasons. A run that synced nothing says so - it does not claim success.
      const sleep = res.sleep || {};
      const steps = res.steps || {};
      const summary = `Sleep: ${sleep.message || "-"} Steps: ${steps.message || "-"}`;
      const anyFailed = (sleep.failed || 0) + (steps.failed || 0) > 0;
      setResult(summary, anyFailed);

      writeLastSync({
        at: res.at,
        summary: `${sleep.synced || 0} sleep, ${steps.synced || 0} steps`,
      });
      renderLastSync();
    } catch (err) {
      setResult(`Sync failed: ${err?.message || err}`, true);
    } finally {
      await refreshAvailability();
    }
  });

  renderLastSync();
  refreshAvailability();
}
