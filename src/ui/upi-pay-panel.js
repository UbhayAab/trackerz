// Money-page panel: pay someone over UPI from inside the app.
//
// DOM + event binding only. All logic (validation, the upi:// link, the confirmed
// -payment logging) lives in src/services/upi-pay.js. Honest "Android app only"
// state in a browser - a browser cannot launch a UPI payment.
//
// Mounts into #upiPayPanel if present, no-ops otherwise. UNTESTED ON HARDWARE.

import { payAndLog, isNativeUpiAvailable, validatePayInput } from "../services/upi-pay.js";

/** Mount the pay panel. `onLogged` is called after a payment is logged, to refresh totals. */
export function mountUpiPayPanel(onLogged) {
  const panel = document.getElementById("upiPayPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Pay via UPI</p>
        <h2>Pay and log it in one tap</h2>
      </div>
      <span id="upiStatePill" class="status-pill muted">checking…</span>
    </div>
    <p id="upiHint" class="muted small" style="margin:0 0 10px"></p>
    <div class="upi-pay-form" style="display:grid;gap:8px;max-width:420px">
      <input id="upiVpa" type="text" inputmode="email" autocomplete="off" placeholder="Payee UPI ID (name@bank)" class="text-input" />
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input id="upiAmount" type="number" min="1" step="1" placeholder="Amount (Rs)" class="text-input" />
        <input id="upiNote" type="text" placeholder="Note (optional)" class="text-input" />
      </div>
      <button id="upiPayBtn" class="primary-button" type="button">Pay</button>
    </div>
    <p id="upiResult" class="muted small" aria-live="polite" style="margin:10px 0 0"></p>
  `;

  const pill = panel.querySelector("#upiStatePill");
  const hintEl = panel.querySelector("#upiHint");
  const vpaEl = panel.querySelector("#upiVpa");
  const amountEl = panel.querySelector("#upiAmount");
  const noteEl = panel.querySelector("#upiNote");
  const payBtn = panel.querySelector("#upiPayBtn");
  const resultEl = panel.querySelector("#upiResult");

  const setResult = (text, isError = false) => {
    resultEl.textContent = text || "";
    resultEl.style.color = isError ? "#f87171" : "";
  };

  if (!isNativeUpiAvailable()) {
    pill.textContent = "Android app only";
    hintEl.textContent =
      "Paying opens your UPI app (GPay/PhonePe) with the amount prefilled, then logs the " +
      "spend automatically. This only works in the Trackerz Android app.";
    vpaEl.disabled = true; amountEl.disabled = true; noteEl.disabled = true; payBtn.disabled = true;
    return;
  }

  pill.textContent = "Ready";
  pill.classList.remove("muted");
  hintEl.textContent =
    "Opens your UPI app with the payee and amount filled in. Once you approve, a " +
    "confirmed payment is logged here (duplicates from your bank SMS are merged).";

  payBtn.addEventListener("click", async () => {
    const vpa = vpaEl.value.trim();
    const amount = Number(amountEl.value);
    const note = noteEl.value.trim();
    const valid = validatePayInput({ vpa, amount });
    if (!valid.ok) {
      setResult(valid.reason === "bad_vpa" ? "Enter a valid UPI ID (name@bank)."
        : valid.reason === "amount_too_large" ? "Amount is above the UPI per-payment limit."
        : "Enter a valid amount.", true);
      return;
    }
    payBtn.disabled = true;
    setResult("Opening your UPI app…");
    try {
      const res = await payAndLog({ vpa, amount, note });
      setResult(res?.message || "Done.", res?.status === "failure" || res?.error);
      if (res?.logged) {
        amountEl.value = ""; noteEl.value = "";
        try { onLogged?.(); } catch { /* refresh is best-effort */ }
      }
    } catch (err) {
      setResult(`Payment failed: ${err?.message || err}`, true);
    } finally {
      payBtn.disabled = false;
    }
  });
}
