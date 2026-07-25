// Settings panel: automatic spend capture. The whole point is that the user NEVER
// changes how they pay - Trackerz logs spend from the signals every payment already
// leaves on the phone: payment/bank NOTIFICATIONS (primary, origin-agnostic) and
// bank SMS (backstop for card/laptop/ATM).
//
// DOM + event binding only. Logic lives in notification-capture.js + sms-capture.js.
// Honest "Android app only" state in a browser. Mounts into #spendCapturePanel.
// UNTESTED ON HARDWARE.

import {
  isNativeNotifyAvailable, isAccessEnabled, openAccessSettings, drainAndCapture,
  isAutoCaptureEnabled as notifyEnabled, setAutoCaptureEnabled as setNotifyEnabled,
} from "../services/notification-capture.js";
import {
  isNativeSmsAvailable, checkPermission as smsCheck, requestPermission as smsRequest, backfill as smsBackfill,
  isAutoCaptureEnabled as smsEnabled, setAutoCaptureEnabled as setSmsEnabled,
} from "../services/sms-capture.js";
import { apkCalloutHtml } from "./apk-link.js";

export function mountSpendCapturePanel() {
  const panel = document.getElementById("spendCapturePanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Automatic spend</p>
        <h2>Log every payment, no typing</h2>
      </div>
      <span id="spendStatePill" class="status-pill muted">checking…</span>
    </div>
    <p id="spendIntro" class="muted small" style="margin:0 0 12px"></p>
    <div id="spendNative" hidden>
      <div class="account-grid">
        <div class="account-row">
          <span class="muted small">Payment notifications <em>(primary)</em></span>
          <label class="switch-inline"><input id="notifyToggle" type="checkbox" /> <span id="notifyState">-</span></label>
        </div>
        <div class="account-row">
          <span class="muted small">Bank SMS <em>(backstop)</em></span>
          <label class="switch-inline"><input id="smsToggle" type="checkbox" /> <span id="smsState">-</span></label>
        </div>
      </div>
      <div class="data-actions">
        <button id="notifyGrantBtn" class="secondary-button" type="button">Turn on notifications</button>
        <button id="smsGrantBtn" class="secondary-button" type="button">Grant SMS</button>
        <button id="spendSyncBtn" class="primary-button" type="button">Sync now</button>
      </div>
      <p id="spendResult" class="muted small" aria-live="polite" style="margin:10px 0 0"></p>
    </div>
  `;

  const pill = panel.querySelector("#spendStatePill");
  const intro = panel.querySelector("#spendIntro");
  const nativeWrap = panel.querySelector("#spendNative");
  const notifyToggle = panel.querySelector("#notifyToggle");
  const notifyState = panel.querySelector("#notifyState");
  const smsToggle = panel.querySelector("#smsToggle");
  const smsState = panel.querySelector("#smsState");
  const notifyGrantBtn = panel.querySelector("#notifyGrantBtn");
  const smsGrantBtn = panel.querySelector("#smsGrantBtn");
  const syncBtn = panel.querySelector("#spendSyncBtn");
  const resultEl = panel.querySelector("#spendResult");

  const setResult = (t, err = false) => { resultEl.textContent = t || ""; resultEl.style.color = err ? "#f87171" : ""; };

  const nativeNotify = isNativeNotifyAvailable();
  const nativeSms = isNativeSmsAvailable();

  if (!nativeNotify && !nativeSms) {
    pill.textContent = "Android app only";
    intro.innerHTML =
      "There is no GPay or UPI API to read your transactions. What every payment DOES " +
      "leave on your phone is a notification and a bank SMS - and only the Trackerz " +
      "Android app can read those. Install it, open this page there, and turn this on. " +
      "Then you pay exactly as you do today (Zepto, a website, a shop QR, your card) and " +
      "every rupee is logged for you, with no entry to come back and make." +
      apkCalloutHtml("This is the only way payments log themselves. In a browser it cannot work at all.");
    return;
  }

  nativeWrap.hidden = false;
  pill.textContent = "Ready";
  pill.classList.remove("muted");
  intro.textContent =
    "You never change how you pay. Trackerz reads the payment notification and bank SMS " +
    "each purchase already creates on this phone, and logs it. Notifications catch UPI " +
    "apps (Zepto, shop QRs, GPay); SMS catches card, bank and laptop payments.";

  notifyToggle.checked = notifyEnabled();
  smsToggle.checked = smsEnabled();

  async function refresh() {
    // Notifications
    if (nativeNotify) {
      const acc = await isAccessEnabled();
      notifyState.textContent = acc.enabled ? (notifyToggle.checked ? "On" : "Off (granted)") : "Access needed";
      notifyGrantBtn.disabled = acc.enabled;
      notifyToggle.disabled = !acc.enabled;
    } else {
      notifyState.textContent = "n/a"; notifyGrantBtn.disabled = true; notifyToggle.disabled = true;
    }
    // SMS
    if (nativeSms) {
      const perm = await smsCheck();
      const granted = perm?.outcome === "granted";
      smsState.textContent = granted ? (smsToggle.checked ? "On" : "Off (granted)") : "Permission needed";
      smsGrantBtn.disabled = granted;
      smsToggle.disabled = !granted;
    } else {
      smsState.textContent = "n/a"; smsGrantBtn.disabled = true; smsToggle.disabled = true;
    }
  }

  notifyToggle.addEventListener("change", () => { setNotifyEnabled(notifyToggle.checked); refresh(); });
  smsToggle.addEventListener("change", () => { setSmsEnabled(smsToggle.checked); refresh(); });

  notifyGrantBtn.addEventListener("click", async () => {
    setResult("Opening notification-access settings. Turn on Trackerz, then come back.");
    await openAccessSettings();
    setNotifyEnabled(true); notifyToggle.checked = true;
  });

  smsGrantBtn.addEventListener("click", async () => {
    smsGrantBtn.disabled = true;
    setResult("Requesting SMS permission…");
    try {
      const res = await smsRequest();
      setResult(res?.message || "", res?.outcome !== "granted");
      if (res?.outcome === "granted") { setSmsEnabled(true); smsToggle.checked = true; }
    } catch (err) { setResult(`Could not request permission: ${err?.message || err}`, true); }
    finally { await refresh(); }
  });

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    setResult("Reading recent payments…");
    try {
      const parts = [];
      if (nativeNotify && (await isAccessEnabled()).enabled) {
        const r = await drainAndCapture();
        if (r?.supported) parts.push(`Notifications: ${r.message}`);
      }
      if (nativeSms && (await smsCheck())?.outcome === "granted") {
        const r = await smsBackfill({ days: 14 });
        if (r?.supported) parts.push(`SMS: ${r.message}`);
      }
      setResult(parts.length ? parts.join(" ") : "Grant access first, then Sync.");
    } catch (err) { setResult(`Sync failed: ${err?.message || err}`, true); }
    finally { syncBtn.disabled = false; await refresh(); }
  });

  refresh();
}
