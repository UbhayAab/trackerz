import { hydrateStateFromSupabase } from "../state/sync.js";
import { showToast } from "./toast.js";

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
    : `<li class="insight insight-empty">No insights yet - add your first capture and the AI summary appears here.</li>`;
}

// The Refresh button used to grab the first insight line and prepend the literal
// word "Refreshed: " to it. No fetch, no recompute. Tapping it three times gave
// you "Refreshed: Refreshed: Refreshed: <insight>". It now does the thing it says.
export function bindInsights() {
  const btn = document.querySelector("#refreshInsights");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      // hydrateStateFromSupabase reports partial failures by RETURNING a status
      // rather than throwing, so checking the result is the only way to know.
      const status = await hydrateStateFromSupabase();
      if (status && status.ok === false) {
        showToast(`Refreshed, but some reads failed: ${status.failed?.[0] || "sync error"}`, { kind: "error", duration: 5000 });
      }
    } catch (err) {
      showToast(`Couldn't refresh: ${err?.message || err}`, { kind: "error", duration: 5000 });
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}
