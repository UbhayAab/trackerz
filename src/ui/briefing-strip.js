// Home briefing card. Renders the proactive morning/evening briefing at the top
// of the Home feed; a dismiss ✕ marks it seen so it doesn't reappear. The HTML
// builder is pure (DOM-free) and importable by Node tests — the Supabase-backed
// markBriefingSeen is loaded lazily on dismiss so this module has no client
// import chain.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function briefingStripHtml(briefing) {
  if (!briefing || !briefing.body) return "";
  const p = briefing.payload || {};
  const nudges = p.nudges || [];
  // The nightly brain's extras: habituation-filtered insights, one wandering
  // thought (or dream trajectory), one curiosity question, the weekly
  // calibration confession. All optional — older rows simply don't have them.
  const insights = (p.insights || []).slice(0, 3);
  const thought = p.thought?.text || "";
  const thoughtLabel = p.thought?.kind === "dream" ? "What-if" : "Thought";
  const question = p.question || "";
  const calibration = p.calibration || "";
  const kind = briefing.kind === "evening" ? "evening" : "morning";
  return `<div class="briefing-card briefing-${kind}" data-id="${esc(briefing.id || "")}">`
    + `<button class="briefing-dismiss" type="button" aria-label="Dismiss briefing">✕</button>`
    + `<p class="briefing-body">${esc(briefing.body)}</p>`
    + (nudges.length ? `<ul class="briefing-nudges">${nudges.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "")
    + (insights.length ? `<ul class="briefing-insights">${insights.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "")
    + (thought ? `<p class="briefing-thought"><span class="briefing-tag">${esc(thoughtLabel)}</span> ${esc(thought)}</p>` : "")
    + (question ? `<p class="briefing-question"><span class="briefing-tag">Question</span> ${esc(question)}</p>` : "")
    + (calibration ? `<p class="briefing-calibration">${esc(calibration)}</p>` : "")
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
      if (briefing.id) {
        import("../services/briefing.js")
          .then((m) => m.markBriefingSeen(briefing.id))
          .catch(() => {});
      }
    });
  }
}
