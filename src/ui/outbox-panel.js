// THE OUTBOX, MADE VISIBLE.
//
// A durable queue nobody can see is only half a fix. Before this, a capture that
// failed left a row in the DOM that vanished on the next reload, so the user had
// no way to tell "still trying" from "gone" - and the honest answer to "where did
// my capture go" was buried in IndexedDB where only a developer could find it.
//
// Renders every item that is not `sent`, from storage, on boot and after every
// change. Four states, always visible, never silence:
//
//   queued    - waiting for signal, saved on this phone
//   sending   - in flight right now
//   retrying  - failed, will try again, with the reason and the countdown
//   attention - stopped trying, with what to DO about it
//
// "Processed, zero rows, silence" is what made 19 of 89 captures disappear
// without a signal, which is why the owner re-submitted and created duplicates.

import { $ } from "../utils/dom.js";
import { terminalLabel } from "../../lib/outbox.mjs";
import { listOfflineQueue, discardCapture, retryNow, forget, outboxStats } from "../services/offline-queue.js";

// Same five-character escape as ui/reminders-panel.js. The summary is whatever
// the user typed, pasted or dictated, and it goes through innerHTML.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function summaryOf(item) {
  const text = (item.text || "").trim();
  if (text) return text.slice(0, 80);
  const n = (item.files || []).length;
  return n ? `${n} file${n === 1 ? "" : "s"}` : "capture";
}

function whenLabel(item, now) {
  if (item.state !== "failed" || !item.nextAttemptAt) return "";
  const secs = Math.max(0, Math.round((item.nextAttemptAt - now) / 1000));
  if (secs <= 0) return "retrying now";
  if (secs < 60) return `retrying in ${secs}s`;
  return `retrying in ${Math.round(secs / 60)} min`;
}

// What stopped it, phrased as what to DO. "Capture failed - [object Object]"
// tells the user nothing, and a user who cannot act re-submits, which is how a
// failure becomes a duplicate row.
function deadLabel(item) {
  switch (item.lastErrorKind) {
    case "auth": return "You're signed out. Sign in, then tap Retry.";
    case "cap": return "Today's AI budget is used up. This will keep until tomorrow.";
    case "rejected": return "The server couldn't read this one.";
    case "captive_portal": return "That WiFi wants you to sign in first.";
    default: return item.lastError ? `${item.lastError}. Tap Retry.` : "Stopped trying. Tap Retry.";
  }
}

function rowHtml(item, now) {
  const label = terminalLabel(item);
  const kind = label?.kind || "queued";
  const summary = esc(summaryOf(item));
  let detail;
  let actions = "";

  if (kind === "sending") {
    detail = esc(liveDetail.get(item.id) || "Sending…");
  } else if (kind === "retrying") {
    detail = `${esc(item.lastError || "Couldn't send")} - ${whenLabel(item, now)}`;
    actions = `<button type="button" class="link-button" data-ob="retry" data-id="${esc(item.id)}">Retry now</button>`;
  } else if (kind === "needs_attention") {
    detail = esc(deadLabel(item));
    actions = `
      <button type="button" class="link-button" data-ob="retry" data-id="${esc(item.id)}">Retry</button>
      <button type="button" class="link-button" data-ob="discard" data-id="${esc(item.id)}">Discard</button>`;
  } else if (kind === "discarded") {
    detail = "Discarded.";
    actions = `<button type="button" class="link-button" data-ob="forget" data-id="${esc(item.id)}">Dismiss</button>`;
  } else {
    detail = navigator.onLine ? "Queued." : "Waiting for signal - saved on this phone.";
  }

  return `
    <div class="outbox-row" data-state="${esc(kind)}">
      <span class="outbox-dot" aria-hidden="true"></span>
      <div class="outbox-body">
        <strong>${summary}</strong>
        <span class="outbox-status">${detail}</span>
      </div>
      <div class="outbox-actions">${actions}</div>
    </div>`;
}

let host = null;
let runCaptureRef = null;
let ticking = null;

// Live stage text for the capture currently in flight, keyed by outbox id.
// The outbox knows an item is `sending`; only the runner knows it is on
// "Reading your photo" rather than "Working it out", and that difference is
// most of what makes a 30 s wait tolerable.
const liveDetail = new Map();

export function setLiveDetail(id, text) {
  if (!id) return;
  if (text) liveDetail.set(id, text); else liveDetail.delete(id);
  renderOutbox();
}

export function bindOutboxPanel(runCapture) {
  runCaptureRef = runCapture;
  host = $("#optimisticQueue");
  if (!host) return;
  host.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-ob]");
    if (!btn) return;
    const { ob, id } = btn.dataset;
    btn.disabled = true;
    try {
      if (ob === "retry") await retryNow(id, runCaptureRef);
      else if (ob === "discard") await discardCapture(id);
      else if (ob === "forget") await forget(id);
    } catch (err) {
      console.error("[outbox-panel] action failed:", err);
    }
    await renderOutbox();
  });
  // Re-render while anything is counting down, so "retrying in 42s" is true.
  window.addEventListener("online", () => renderOutbox());
  window.addEventListener("offline", () => renderOutbox());
}

export async function renderOutbox() {
  if (!host) host = $("#optimisticQueue");
  if (!host) return;
  let items = [];
  try {
    items = await listOfflineQueue();
  } catch (err) {
    // A failed read of the outbox must not render as an empty outbox - that is
    // the exact "absent looks like nothing to do" failure this codebase keeps
    // making. Say the queue is unreadable.
    console.error("[outbox-panel] could not read the outbox:", err);
    host.innerHTML = `<div class="outbox-row" data-state="needs_attention">
      <span class="outbox-dot" aria-hidden="true"></span>
      <div class="outbox-body"><strong>Can't read the outbox</strong>
      <span class="outbox-status">${esc(err?.message || "storage unavailable")}</span></div></div>`;
    return;
  }

  const now = Date.now();
  const live = items.filter((i) => i.state !== "sent");
  host.innerHTML = live.map((i) => rowHtml(i, now)).join("");

  const counting = live.some((i) => i.state === "failed" || i.state === "sending");
  if (counting && !ticking) ticking = setInterval(() => renderOutbox(), 1000);
  if (!counting && ticking) { clearInterval(ticking); ticking = null; }

  await renderOutboxBanner();
}

// One line above the fold when anything is waiting, so the state is knowable
// without scrolling to find a row.
async function renderOutboxBanner() {
  let stats;
  try { stats = await outboxStats(); } catch { return; }
  let el = document.getElementById("outboxBanner");
  const needed = stats.depth > 0 || stats.dead > 0;
  if (!needed) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "outboxBanner";
    el.className = "outbox-banner";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    host?.parentNode?.insertBefore(el, host);
  }
  const parts = [];
  if (stats.depth) parts.push(`${stats.depth} capture${stats.depth === 1 ? "" : "s"} waiting`);
  if (stats.dead) parts.push(`${stats.dead} need${stats.dead === 1 ? "s" : ""} attention`);
  const offline = !navigator.onLine ? "You're offline. " : "";
  el.textContent = `${offline}${parts.join(", ")}.`;
}
