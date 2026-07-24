// Settings-page panel for SMS auto-capture of UPI/bank spend.
//
// DOM + event binding only (src/ui/ layer rule): every fact it shows comes from
// src/services/sms-capture.js, the only module allowed to touch the native bridge
// or the capture pipeline.
//
// Truthful in a browser: on the GitHub Pages PWA there is no native bridge, so it
// renders a plain "this needs the Android app" state with actions disabled - it
// never shows a fake "connected".
//
// Mounts into #smsPanel if present, no-ops otherwise.
//
// UNTESTED ON HARDWARE. The browser state is what you can see today; the granted /
// synced states have never been rendered against a real device inbox.

import {
  availability,
  requestPermission,
  checkPermission,
  backfill,
  isNativeSmsAvailable,
  isAutoCaptureEnabled,
  setAutoCaptureEnabled,
} from "../services/sms-capture.js";

export function mountSmsPanel() {
  const panel = document.getElementById("smsPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">UPI auto-capture</p>
        <h2>Log spend from bank SMS, no typing</h2>
      </div>
      <span id="smsStatePill" class="status-pill muted">checking…</span>
    </div>
    <div class="account-grid">
      <div class="account-row">
        <span class="muted small">Auto-capture</span>
        <label class="switch-inline"><input id="smsToggle" type="checkbox" /> <span id="smsToggleLabel">Off</span></label>
      </div>
      <div class="account-row">
        <span class="muted small">Permission</span>
        <strong id="smsPermText">-</strong>
      </div>
    </div>
    <p id="smsHint" class="muted small" style="margin:8px 0 0"></p>
    <div class="data-actions">
      <button id="smsGrantBtn" class="secondary-button" type="button">Grant SMS access</button>
      <button id="smsSyncBtn" class="primary-button" type="button">Sync now</button>
    </div>
    <p id="smsResult" class="muted small" aria-live="polite" style="margin:10px 0 0"></p>
  `;

  const pill = panel.querySelector("#smsStatePill");
  const toggle = panel.querySelector("#smsToggle");
  const toggleLabel = panel.querySelector("#smsToggleLabel");
  const permText = panel.querySelector("#smsPermText");
  const hintEl = panel.querySelector("#smsHint");
  const grantBtn = panel.querySelector("#smsGrantBtn");
  const syncBtn = panel.querySelector("#smsSyncBtn");
  const resultEl = panel.querySelector("#smsResult");

  function setResult(text, isError = false) {
    resultEl.textContent = text || "";
    resultEl.style.color = isError ? "#f87171" : "";
  }

  // ------ browser (no bridge): say so plainly, disable actions, stop here.
  if (!isNativeSmsAvailable()) {
    pill.textContent = "Android app only";
    permText.textContent = "n/a";
    toggle.disabled = true;
    grantBtn.disabled = true;
    syncBtn.disabled = true;
    hintEl.textContent =
      "There is no GPay or UPI API to read your transactions. What every UPI payment " +
      "does create is a bank SMS on your phone, and only the Trackerz Android app can " +
      "read it. Install the APK (from the latest build), open this page there, switch " +
      "this on, and every UPI/bank debit is logged automatically.";
    return;
  }

  // ------ native: reflect real permission state.
  toggle.checked = isAutoCaptureEnabled();
  toggleLabel.textContent = toggle.checked ? "On" : "Off";

  async function refresh() {
    setResult("");
    const a = await availability();
    if (a && a.supported === false) {
      pill.textContent = "No telephony";
      hintEl.textContent = a.message || "This device cannot read SMS.";
      grantBtn.disabled = true;
      syncBtn.disabled = true;
      return;
    }
    const perm = await checkPermission();
    const granted = perm?.outcome === "granted";
    pill.textContent = granted ? "Ready" : "Needs permission";
    pill.classList.toggle("muted", !granted);
    permText.textContent = granted ? "Granted" : "Not granted";
    hintEl.textContent = granted
      ? "Every UPI/bank debit SMS is parsed and logged as an expense. Duplicates are ignored."
      : "Tap Grant SMS access, then Sync now to pull your recent spend.";
    grantBtn.disabled = granted;
    syncBtn.disabled = !granted;
  }

  toggle.addEventListener("change", () => {
    setAutoCaptureEnabled(toggle.checked);
    toggleLabel.textContent = toggle.checked ? "On" : "Off";
    setResult(toggle.checked
      ? "Auto-capture on. New spend SMS will be logged as they arrive."
      : "Auto-capture off. Bank SMS will be ignored until you switch it back on.");
  });

  grantBtn.addEventListener("click", async () => {
    grantBtn.disabled = true;
    setResult("Requesting SMS permission…");
    try {
      const res = await requestPermission();
      setResult(res?.message || "", res?.outcome !== "granted");
      if (res?.outcome === "granted" && !isAutoCaptureEnabled()) {
        setAutoCaptureEnabled(true);
        toggle.checked = true;
        toggleLabel.textContent = "On";
      }
    } catch (err) {
      setResult(`Could not request permission: ${err?.message || err}`, true);
    } finally {
      await refresh();
    }
  });

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    grantBtn.disabled = true;
    setResult("Reading recent SMS…");
    try {
      const res = await backfill({ days: 14 });
      if (!res?.supported) { setResult(res?.message || "Not available.", true); return; }
      setResult(res.message || "Done.", (res.failed || 0) > 0);
    } catch (err) {
      setResult(`Sync failed: ${err?.message || err}`, true);
    } finally {
      await refresh();
    }
  });

  refresh();
}
