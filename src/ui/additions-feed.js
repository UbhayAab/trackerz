// The Home "additions" feed: a day-over-day list of everything that landed
// (auto-committed), newest first, each row deletable with a single ✕. No approve
// step — checking/capturing IS the commit; the feed is the trust signal + undo.
// Shaping is pure (lib/additions.mjs); this module is the DOM + write side.

import { buildAdditions, groupByDay } from "../../lib/additions.mjs";
import { deleteRow } from "../services/supabase-data.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function dayLabel(dayKey) {
  const now = new Date();
  const t = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const yk = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (dayKey === t) return "Today";
  if (dayKey === yk) return "Yesterday";
  return dayKey;
}

export function renderAdditionsFeed(state) {
  const el = document.querySelector("#additionsFeed");
  if (!el) return;
  const items = Array.isArray(state.additions) ? state.additions : [];
  if (!items.length) {
    el.innerHTML = `<p class="muted small">Nothing logged yet. Capture anything above — it lands here and you can delete any row with ✕.</p>`;
    return;
  }
  el.innerHTML = groupByDay(items).map((g) => `
    <div class="add-day">
      <p class="add-day-head">${dayLabel(g.dayKey)}</p>
      ${g.rows.map((r) => `
        <div class="add-row add-${r.domain}" data-add-table="${esc(r.table)}" data-add-id="${esc(r.id)}">
          <span class="add-domain">${esc(r.domain)}</span>
          <span class="add-label">${esc(r.label)}</span>
          <span class="add-delta">${esc(r.delta)}</span>
          <button class="add-del" type="button" aria-label="Delete ${esc(r.label)}">✕</button>
        </div>`).join("")}
    </div>`).join("");
}

let bound = false;
export function bindAdditionsFeed() {
  if (bound) return;
  bound = true;
  const el = document.querySelector("#additionsFeed");
  if (!el) return;
  el.addEventListener("click", async (event) => {
    const btn = event.target.closest(".add-del");
    if (!btn) return;
    const rowEl = btn.closest("[data-add-id]");
    if (!rowEl) return;
    rowEl.classList.add("is-deleting"); // red strike-through while it deletes
    try {
      await deleteRow(rowEl.dataset.addTable, rowEl.dataset.addId);
      await hydrateStateFromSupabase();
    } catch {
      rowEl.classList.remove("is-deleting"); // delete failed — restore the row
    }
  });
}

// Re-exported so callers can shape additions without importing the pure lib path.
export { buildAdditions };
