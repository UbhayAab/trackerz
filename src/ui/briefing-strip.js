// Home Jarvis panel. Renders the proactive briefing at the top of the Home feed —
// the LLM-voiced body written server-side by the jarvis edge fn, plus fact chips
// (streaks, safe-to-spend, weekly workouts) pulled from payload.facts, or the
// nudge chips for evening/legacy rows. A dismiss ✕ marks it seen. The HTML
// builder is pure (DOM-free) and reused by tests if needed.

import { markBriefingSeen } from "../services/briefing.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function rupees(n) {
  return "Rs " + Math.round(Number(n) || 0).toLocaleString("en-IN");
}

// Fact chips for a server morning brief (payload.facts from jbBriefFacts).
function factChips(facts) {
  if (!facts || typeof facts !== "object") return [];
  const chips = [];
  const st = facts.streaks || {};
  if (st.workout > 1) chips.push(`gym streak ${st.workout}d`);
  if (st.protein > 1) chips.push(`protein streak ${st.protein}d`);
  if (st.budget > 1) chips.push(`budget streak ${st.budget}d`);
  if (facts.money && facts.money.hasBudget) chips.push(`safe today ${rupees(facts.money.perDay)}`);
  const ww = facts.weekly_workouts;
  if (ww && ww.target) chips.push(`workouts ${ww.done}/${ww.target} this week`);
  for (const s of (facts.subs_due || []).slice(0, 2)) {
    chips.push(`${s.merchant} ${rupees(s.amount)} in ${s.in_days}d`);
  }
  return chips;
}

export function briefingStripHtml(briefing) {
  if (!briefing || !briefing.body) return "";
  const payload = briefing.payload || {};
  const chips = payload.facts ? factChips(payload.facts) : (payload.nudges || []);
  const kind = briefing.kind === "evening" ? "evening" : "morning";
  const slotLabel = kind === "evening" ? "evening check-in" : "morning brief";
  return `<div class="briefing-card briefing-${kind}" data-id="${esc(briefing.id || "")}">`
    + `<button class="briefing-dismiss" type="button" aria-label="Dismiss briefing">✕</button>`
    + `<p class="briefing-eyebrow">Jarvis · ${slotLabel}</p>`
    + `<p class="briefing-body">${esc(briefing.body)}</p>`
    + (chips.length ? `<ul class="briefing-nudges">${chips.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "")
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
