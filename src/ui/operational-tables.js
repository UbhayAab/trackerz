import { updateState, getState } from "../state/app-state.js";
import { renderTable } from "./table-renderer.js";
import { isLocalSession } from "../services/auth.js";
import { applyProposedAction, applyProposedActions, applyAiAction, rejectAiAction } from "../services/supabase-data.js";
import { APPLIER_WRITE_TOOLS } from "../services/action-applier.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

const reviewColumns = [
  { key: "item", label: "Item", strong: true },
  { key: "domain", label: "Domain", badge: true },
  { key: "confidence", label: "Conf." },
  { key: "risk", label: "Risk", badge: true },
  { key: "action", label: "Action" },
  { key: "ops", label: "Ops", actions: [{ label: "✕ Delete", action: "drop" }] },
];

const importColumns = [
  { key: "file", label: "File", strong: true },
  { key: "rows", label: "Rows" },
  { key: "mapped", label: "Mapped" },
  { key: "duplicate", label: "Dupes" },
  { key: "status", label: "Status", badge: true },
  // Re-importing an already-recorded statement isn't built: the original file is
  // never kept, and nothing promotes statement_rows into the ledger. This button
  // used to fabricate a row count and flip the row to "imported" without writing
  // anything, so it now says what it is and can't be pressed.
  {
    key: "ops",
    label: "Ops",
    actions: [{
      label: "Not wired up",
      action: "import",
      disabled: true,
      title: "Row-level import isn't implemented. Drop the statement file into the importer above to import it.",
    }],
  },
];

const ledgerColumns = [
  { key: "date", label: "Date" },
  { key: "merchant", label: "Merchant", strong: true },
  { key: "category", label: "Category" },
  { key: "amount", label: "Amount", strong: true },
  { key: "evidence", label: "Evidence" },
  { key: "state", label: "State", badge: true },
];

const budgetColumns = [
  { key: "category", label: "Category", strong: true },
  { key: "spent", label: "Spent" },
  { key: "pace", label: "Pace", badge: true },
  { key: "forecast", label: "Forecast" },
  { key: "next", label: "Next" },
];

const macroColumns = [
  { key: "meal", label: "Meal", strong: true },
  { key: "calories", label: "Cal" },
  { key: "protein", label: "Protein" },
  { key: "confidence", label: "Conf.", badge: true },
  { key: "note", label: "Note" },
];

// `options.errors` maps a table key (review/import/ledger/budget/macro) to the
// message from the read that failed, and `options.loading` says the data hasn't
// been read yet. Without those, a failed or pending read is indistinguishable
// from an empty account - which is how "couldn't read your ledger" ended up
// rendering as "no expenses yet".
//
// `options.rows` / `options.emptyMessages` let a page substitute a narrowed row
// set for a table and word its own empty state - the Money page shows only the
// selected period, where "no rows" means "nothing spent this day", not "no
// expenses ever". The wording has to travel with the rows, otherwise a filtered
// view borrows the global copy and makes a claim about the wrong window.
export function renderOperationalTables(state, options = {}) {
  const errors = options.errors || {};
  const rows = options.rows || {};
  const empties = options.emptyMessages || {};
  const loading = Boolean(options.loading);
  const pick = (key, fallback) => (rows[key] !== undefined ? rows[key] : fallback);
  const empty = (key, fallback) => empties[key] || fallback;

  setTable("#reviewTable", reviewColumns, pick("review", state.reviewRows), { table: "review", emptyMessage: empty("review", "Nothing yet today. Captures auto-commit here as additions - delete any that are wrong."), error: errors.review, loading });
  setTable("#importTable", importColumns, pick("import", state.importRows), { table: "import", emptyMessage: empty("import", "No bank files yet. Upload CSV, Excel, PDF, or screenshots from Capture."), error: errors.import, loading });
  setTable("#ledgerTable", ledgerColumns, pick("ledger", state.ledgerRows), { emptyMessage: empty("ledger", "No expenses yet. Add a payment, statement, or screenshot dump."), error: errors.ledger, loading });
  setTable("#budgetTable", budgetColumns, pick("budget", state.budgetRows), { emptyMessage: empty("budget", "No budget burn yet. Add spends or load demo data."), error: errors.budget, loading });
  setTable("#macroTable", macroColumns, pick("macro", state.macroRows), { emptyMessage: empty("macro", "No meals yet. Add food text, photo, or EOD voice note."), error: errors.macro, loading });
}

export function bindOperationalTables() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".table-action");
    if (!button) return;
    const { table, action, rowId } = button.dataset;
    if (table === "review") handleReviewAction(action, rowId);
  });
}

// Approve = actually write the proposed row server-side and mark the action
// applied; Drop = reject it. Local prototype keeps the optimistic-only path.
async function handleReviewAction(action, rowId) {
  const row = getState().reviewRows.find((r) => r.id === rowId);
  if (!row) return;

  if (isLocalSession()) {
    updateState((state) => {
      if (action === "drop") {
        state.reviewRows = state.reviewRows.filter((r) => r.id !== rowId);
        state.parseLog.unshift(`Dropped review item: ${row.item}`);
      } else {
        const r = state.reviewRows.find((x) => x.id === rowId);
        if (r) { r.risk = "approved"; r.action = "applied"; }
        state.parseLog.unshift(`Approved AI action: ${row.item}`);
      }
    });
    return;
  }

  // Optimistic removal; the trailing re-hydrate reconciles with server truth
  // (a failed apply leaves the action 'proposed', so the row reappears).
  updateState((state) => {
    state.reviewRows = state.reviewRows.filter((r) => r.id !== rowId);
    state.parseLog.unshift(`${action === "drop" ? "Dropped" : "Approving"} review item: ${row.item}`);
  });

  try {
    if (action === "drop") {
      await rejectAiAction(rowId);
    } else {
      const raw = (getState().aiActions || []).find((a) => a.id === rowId);
      if (raw) await applyProposedAction(raw);
      else await applyAiAction(rowId);
    }
  } catch (err) {
    updateState((state) => { state.parseLog.unshift(`Review action failed: ${err?.message || err}`); });
  }
  await hydrateStateFromSupabase().catch(() => {});
}

async function handleApproveAll() {
  if (isLocalSession()) {
    updateState((state) => {
      state.reviewRows.forEach((r) => { r.risk = "approved"; r.action = "applied"; });
      state.parseLog.unshift("Approved all review items (local).");
    });
    return;
  }
  const actions = (getState().aiActions || []).filter((a) => APPLIER_WRITE_TOOLS.includes(a.tool_name));
  if (!actions.length) {
    updateState((state) => { state.parseLog.unshift("No applicable review items to approve."); });
    return;
  }
  updateState((state) => { state.parseLog.unshift(`Approving ${actions.length} review item(s)…`); });
  try {
    const results = await applyProposedActions(actions);
    const ok = results.filter((r) => !r.error).length;
    updateState((state) => { state.parseLog.unshift(`Approved ${ok}/${actions.length} review item(s).`); });
  } catch (err) {
    updateState((state) => { state.parseLog.unshift(`Bulk approve failed: ${err?.message || err}`); });
  }
  await hydrateStateFromSupabase().catch(() => {});
}

function setTable(selector, columns, rows, options = {}) {
  const element = document.querySelector(selector);
  if (!element) return;
  const list = Array.isArray(rows) ? rows : [];
  const { error, loading, ...tableOptions } = options;

  if (error) {
    // A read failure must never read as "nothing logged yet".
    element.innerHTML =
      `<div class="import-error"><span class="toast-dot"></span>Couldn't load this table - ${escapeHtml(error)}</div>` +
      renderTable(columns, [], { ...tableOptions, emptyMessage: "Not loaded - see the error above." });
    return;
  }
  if (loading && !list.length) tableOptions.emptyMessage = "Loading…";
  element.innerHTML = renderTable(columns, list, tableOptions);

  // table-renderer has no notion of a disabled action, so mark them after render
  // - an action we can't actually perform must not look pressable.
  for (const column of columns) {
    for (const action of column.actions || []) {
      if (!action.disabled) continue;
      element.querySelectorAll(`.table-action[data-action="${action.action}"]`).forEach((button) => {
        button.disabled = true;
        if (action.title) button.title = action.title;
      });
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
