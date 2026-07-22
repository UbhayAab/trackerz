// The Home "additions" feed: a day-over-day list of everything that landed
// (auto-committed), newest first, each row deletable with a single ✕. No approve
// step — checking/capturing IS the commit; the feed is the trust signal + undo.
// Shaping is pure (lib/additions.mjs); this module is the DOM + write side.

import { buildAdditions, groupByDay } from "../../lib/additions.mjs";
import { deleteRow, revertTargetEvent, rejectAiAction } from "../services/supabase-data.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { showToast } from "./toast.js";

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
        <div class="add-row add-${r.domain}${r.status === "target" ? " is-target" : ""}" data-add-table="${esc(r.table)}" data-add-id="${esc(r.id)}"${r.undoId ? ` data-undo-id="${esc(r.undoId)}"` : ""}>
          <span class="add-domain">${esc(r.domain)}</span>
          <span class="add-label">${esc(r.label)}</span>
          <span class="add-delta">${esc(r.delta)}</span>
          ${r.status === "target"
            ? `<button class="add-undo" type="button" aria-label="Undo ${esc(r.label)}">Undo</button>`
            : r.status === "review"
            ? `<button class="add-dismiss" type="button" aria-label="Dismiss ${esc(r.label)}">✕</button>`
            : `<button class="add-del" type="button" aria-label="Delete ${esc(r.label)}">✕</button>`}
        </div>`).join("")}
    </div>`).join("");
}

// Every row button writes to the DB, so a failure must put the row back AND say
// why: a row that quietly un-strikes reads as "nothing happened" while the row is
// still there. The write and the re-hydrate are separated on purpose — a hydrate
// failure after a successful write must NOT restore the row, or the feed would
// claim the delete never landed.
async function runRowAction(rowEl, label, write) {
  rowEl.classList.add("is-deleting"); // red strike-through while it writes
  try {
    await write();
  } catch (err) {
    rowEl.classList.remove("is-deleting"); // write failed — the row is still in the DB
    showToast(`${label} failed: ${err?.message || err}`, { kind: "error", duration: 5000 });
    return;
  }
  // hydrateStateFromSupabase reports partial failures by RETURNING a status
  // rather than throwing (page boot must survive one dead read), so a catch
  // alone would never fire — check the result.
  let status;
  try {
    status = await hydrateStateFromSupabase();
  } catch (err) {
    status = { ok: false, failed: [err?.message || String(err)] };
  }
  if (status && status.ok === false) {
    showToast(`${label} saved, but the feed couldn't refresh: ${status.failed?.[0] || "sync failed"}`, { kind: "error", duration: 5000 });
  }
}

let bound = false;
export function bindAdditionsFeed() {
  if (bound) return;
  bound = true;
  const el = document.querySelector("#additionsFeed");
  if (!el) return;
  el.addEventListener("click", async (event) => {
    const undoBtn = event.target.closest(".add-undo");
    if (undoBtn) {
      const rowEl = undoBtn.closest("[data-undo-id]");
      if (!rowEl) return;
      await runRowAction(rowEl, "Undo", () => revertTargetEvent(rowEl.dataset.undoId));
      return;
    }
    const dismissBtn = event.target.closest(".add-dismiss");
    if (dismissBtn) {
      const rowEl = dismissBtn.closest("[data-add-id]");
      if (!rowEl) return;
      await runRowAction(rowEl, "Dismiss", () => rejectAiAction(rowEl.dataset.addId));
      return;
    }
    const btn = event.target.closest(".add-del");
    if (!btn) return;
    const rowEl = btn.closest("[data-add-id]");
    if (!rowEl) return;
    await runRowAction(rowEl, "Delete", () => deleteRow(rowEl.dataset.addTable, rowEl.dataset.addId));
  });
}

// Re-exported so callers can shape additions without importing the pure lib path.
export { buildAdditions };
