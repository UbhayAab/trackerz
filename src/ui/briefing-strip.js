// Home briefing card. Renders the proactive morning/evening briefing at the top
// of the Home feed; a dismiss ✕ marks it seen so it doesn't reappear. The HTML
// builder is pure (DOM-free) and reused by tests if needed.

import { markBriefingSeen } from "../services/briefing.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function briefingStripHtml(briefing) {
  if (!briefing || !briefing.body) return "";
  const nudges = briefing.payload?.nudges || [];
  const kind = briefing.kind === "evening" ? "evening" : "morning";
  return `<div class="briefing-card briefing-${kind}" data-id="${esc(briefing.id || "")}">`
    + `<button class="briefing-dismiss" type="button" aria-label="Dismiss briefing">✕</button>`
    + `<p class="briefing-body">${esc(briefing.body)}</p>`
    + (nudges.length ? `<ul class="briefing-nudges">${nudges.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "")
    + `</div>`;
}

export function renderBriefingStrip(host, briefing) {
  if (!host) return;
  if (!briefing || !briefing.body || briefing.seen) { host.innerHTML = ""; return; }
  host.innerHTML = briefingStripHtml(briefing);
  const dismiss = host.querySelector(".briefing-dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      host.innerHTML = "";
      if (briefing.id) markBriefingSeen(briefing.id).catch(() => {});
    });
  }
}
