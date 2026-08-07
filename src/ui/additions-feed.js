// The Home "additions" feed: a day-over-day list of everything that landed
// (auto-committed), newest first, each row deletable with a single ✕. No approve
// step - checking/capturing IS the commit; the feed is the trust signal + undo.
// Shaping is pure (lib/additions.mjs); this module is the DOM + write side.

import { buildAdditions, groupByDay } from "../../lib/additions.mjs";
import { deleteRow, revertTargetEvent, rejectAiAction, applyProposedAction } from "../services/supabase-data.js";
import { getState } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { showToast } from "./toast.js";
import { renderAmendCard, renderAmendChooser, bindDiffCard } from "./diff-card.js";
// A note in THIS feed is one ellipsised 60-character line among the meals and
// the expenses, and `memory_facts` had no surface anywhere in the app. The panel
// renders both in full. It is mounted from here rather than from the page HTML
// so Home adopts it without an edit to index.html or src/pages/capture.js.
import { renderNotesPanel } from "./notes-panel.js";

// The two tools that CHANGE or REMOVE a row that already exists, rather than
// adding one. They are the only actions in this feed where one tap is not
// enough: everything else is an insert whose worst case is a row with a ✕ next
// to it, and these rewrite a number the user has already read.
const AMEND_TOOLS = new Set(["amend_log_candidate", "delete_log_candidate"]);

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
  // Notes and standing facts, in full, beside the feed that truncates them.
  // Deliberately before the early return below: an empty feed is exactly when a
  // reader is most needed, because "Nothing logged yet" over three saved notes
  // is the same lie as a measured zero over missing data.
  renderNotesPanel(state);
  const items = Array.isArray(state.additions) ? state.additions : [];
  if (!items.length) {
    el.innerHTML = `<p class="muted small">Nothing logged yet. Capture anything above - it lands here and you can delete any row with ✕.</p>`;
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
            // A pending capture used to offer ONLY dismiss, so when the agent was
            // rate-limited or unavailable the sole option was to throw the capture
            // away and type it again from memory. The machinery to commit it
            // (applyProposedAction + buildRowForTool) was already written and
            // tested; it just had no button anywhere in the app.
            ? `${r.applicable ? `<button class="add-apply" type="button" aria-label="Add ${esc(r.label)}">Add it</button>` : ""}<button class="add-dismiss" type="button" aria-label="Dismiss ${esc(r.label)}">✕</button>`
            : `<button class="add-del" type="button" aria-label="Delete ${esc(r.label)}">✕</button>`}
        </div>`).join("")}
    </div>`).join("");
}

// Every row button writes to the DB, so a failure must put the row back AND say
// why: a row that quietly un-strikes reads as "nothing happened" while the row is
// still there. The write and the re-hydrate are separated on purpose - a hydrate
// failure after a successful write must NOT restore the row, or the feed would
// claim the delete never landed.
async function runRowAction(rowEl, label, write) {
  rowEl.classList.add("is-deleting"); // red strike-through while it writes
  try {
    await write();
  } catch (err) {
    rowEl.classList.remove("is-deleting"); // write failed - the row is still in the DB
    showToast(`${label} failed: ${err?.message || err}`, { kind: "error", duration: 5000 });
    return;
  }
  // hydrateStateFromSupabase reports partial failures by RETURNING a status
  // rather than throwing (page boot must survive one dead read), so a catch
  // alone would never fire - check the result.
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

// Render the confirm surface for one amendment under its feed row.
//
// Three outcomes, and only the first is a button that writes:
//   resolved  -> the diff card, then one tap applies the stored plan.
//   ambiguous -> a chooser naming up to three rows. Deliberately NOT wired to a
//                write yet: picking a row means re-resolving server-side, and a
//                chooser that silently picked for you is the guess this whole
//                feature refuses to make. It tells the user which rows matched
//                so they can say which one they meant.
//   anything else -> the reason, in a sentence. Never silence.
function showAmendCard(rowEl, action) {
  const args = action?.arguments || {};
  const status = args._amend_status || "unresolved";
  const host = document.createElement("div");
  host.className = "add-amend-card";
  rowEl.after(host);

  if (status === "resolved" && args._amend) {
    const win = args._amend_window;
    host.innerHTML = renderAmendCard(args._amend, {
      summary: `${args.target_ref ? `"${args.target_ref}"` : "this entry"}${win?.label ? ` · ${win.label}` : ""}`,
      id: `amendCard-${action.id}`,
    });
    bindDiffCard(host, {
      onConfirm: async () => {
        host.remove();
        await runRowAction(rowEl, args._amend.op === "soft_delete" ? "Delete" : "Change", () => applyProposedAction(action));
      },
      onCancel: () => host.remove(),
    });
    return;
  }

  if (status === "ambiguous") {
    host.innerHTML = renderAmendChooser((args._amend_choices || []).map((c) => c.label), {
      question: `Which one did you mean by ${args.target_ref ? `"${args.target_ref}"` : "that"}?`,
      id: `amendChooser-${action.id}`,
    });
    bindDiffCard(host, {
      onChoose: () => {
        host.remove();
        showToast("Say which one - retype the correction naming that entry.", { kind: "info", duration: 5000 });
      },
      onCancel: () => host.remove(),
    });
    return;
  }

  const win = args._amend_window;
  const where = win?.label ? ` on ${win.label}` : "";
  const why = {
    not_found: `I could not find ${args.target_ref ? `"${args.target_ref}"` : "that entry"}${where}.`,
    no_rows_in_window: `Nothing is logged${where} to change.`,
    no_change: "That entry already says exactly that - nothing to change.",
    budget_exhausted: "That is more deletions than one day allows. Delete the rest by hand.",
    window_too_wide: "That date range is too wide to amend safely - name one day.",
    lookup_failed: "I could not read that day's entries, so nothing was changed.",
    unknown_kind: "I could not tell which tracker that entry is in.",
  }[status] || `That correction did not resolve to an entry (${status}).`;
  host.innerHTML = `<section class="command-panel diff-card"><p class="small">${esc(why)}</p></section>`;
  showToast(why, { kind: "error", duration: 6000 });
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
    const applyBtn = event.target.closest(".add-apply");
    if (applyBtn) {
      const rowEl = applyBtn.closest("[data-add-id]");
      if (!rowEl) return;
      // applyProposedAction needs the whole action (tool_name + arguments), not
      // just its id - state.aiActions is the raw list the sync already holds.
      const action = (getState().aiActions || []).find((a) => a && a.id === rowEl.dataset.addId);
      if (!action) {
        showToast("That capture is no longer in the queue - refresh and try again.", { kind: "error" });
        return;
      }
      // THE DIFF CARD IS THE SAFETY SURFACE. An amendment does not apply on this
      // tap - it shows what it would change, old struck and dimmed, new in the
      // accent colour, calories and protein first. The second tap applies it.
      //
      // The card is rendered from the plan the SERVER resolved (`_amend`), the
      // same object buildRowForTool executes, so what is approved and what lands
      // cannot disagree. An unresolved amendment shows the reason instead - a
      // chooser when two rows matched, a sentence when none did.
      if (AMEND_TOOLS.has(action.tool_name)) {
        showAmendCard(rowEl, action);
        return;
      }
      await runRowAction(rowEl, "Add", () => applyProposedAction(action));
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
