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
  { key: "ops", label: "Ops", actions: [{ label: "Approve", action: "approve" }, { label: "Drop", action: "drop" }] },
];

const importColumns = [
  { key: "file", label: "File", strong: true },
  { key: "rows", label: "Rows" },
  { key: "mapped", label: "Mapped" },
  { key: "duplicate", label: "Dupes" },
  { key: "status", label: "Status", badge: true },
  { key: "ops", label: "Ops", actions: [{ label: "Import", action: "import" }] },
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

export function renderOperationalTables(state) {
  setTable("#reviewTable", reviewColumns, state.reviewRows, { table: "review", emptyMessage: "No review items yet. Process a capture to create AI-reviewed rows." });
  setTable("#importTable", importColumns, state.importRows, { table: "import", emptyMessage: "No bank files yet. Upload CSV, Excel, PDF, or screenshots from Capture." });
  setTable("#ledgerTable", ledgerColumns, state.ledgerRows, { emptyMessage: "No expenses yet. Add a payment, statement, or screenshot dump." });
  setTable("#budgetTable", budgetColumns, state.budgetRows, { emptyMessage: "No budget burn yet. Add spends or load demo data." });
  setTable("#macroTable", macroColumns, state.macroRows, { emptyMessage: "No meals yet. Add food text, photo, or EOD voice note." });
}

export function bindOperationalTables() {
  document.addEventListener("click", (event) => {
    if (event.target.closest("#approveAllReview")) {
      handleApproveAll();
      return;
    }
    const button = event.target.closest(".table-action");
    if (!button) return;
    const { table, action, rowId } = button.dataset;
    if (table === "review") handleReviewAction(action, rowId);
    if (table === "import") handleImportAction(rowId);
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

function handleImportAction(rowId) {
  updateState((state) => {
    const row = state.importRows.find((item) => item.id === rowId);
    if (!row) return;
    row.rows = row.rows === "detecting" ? "128" : row.rows;
    row.mapped = row.mapped === "pending" ? "93%" : row.mapped;
    row.duplicate = row.duplicate === "pending" ? "18" : row.duplicate;
    row.status = "imported";
    state.parseLog.unshift(`Imported preview rows from ${row.file}`);
  });
}

function setTable(selector, columns, rows, options = {}) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.innerHTML = renderTable(columns, rows, options);
}
