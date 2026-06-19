import { $ } from "../utils/dom.js";

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function row(severity, text) {
  return `<li class="insight insight-${severity}"><span class="insight-dot" aria-hidden="true"></span><span class="insight-text">${escapeHtml(text)}</span></li>`;
}

export function renderInsights(state) {
  const list = document.querySelector("#insightList");
  if (!list) return;

  const parts = [];
  // Surface a sync failure instead of silently showing an empty board.
  if (state.syncError) {
    parts.push(row("critical", `Couldn't load your latest data: ${state.syncError}. Pull to refresh or check your connection.`));
  }

  const items = Array.isArray(state.insightItems) ? state.insightItems : null;
  if (items && items.length) {
    parts.push(...items.map((it) => row(it.severity || "info", it.text)));
  } else if (Array.isArray(state.insights) && state.insights.length) {
    // Local/parse fallback path stores plain strings.
    parts.push(...state.insights.map((line) => row("info", line)));
  }

  list.innerHTML = parts.length
    ? parts.join("")
    : `<li class="insight insight-empty">No insights yet — add your first capture and the AI summary appears here.</li>`;
}

export function bindInsights() {
  if (!document.querySelector("#refreshInsights")) return;
  $("#refreshInsights").addEventListener("click", () => {
    const first = document.querySelector("#insightList .insight-text");
    if (first) first.textContent = `Refreshed: ${first.textContent}`;
  });
}
