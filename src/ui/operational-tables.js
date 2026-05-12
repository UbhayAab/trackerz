import { updateState } from "../state/app-state.js";
import { renderTable } from "./table-renderer.js";

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
  setTable("#reviewTable", reviewColumns, state.reviewRows, { table: "review" });
  setTable("#importTable", importColumns, state.importRows, { table: "import" });
  setTable("#ledgerTable", ledgerColumns, state.ledgerRows);
  setTable("#budgetTable", budgetColumns, state.budgetRows);
  setTable("#macroTable", macroColumns, state.macroRows);
}

export function bindOperationalTables() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".table-action");
    if (!button) return;
    const { table, action, rowId } = button.dataset;
    if (table === "review") {
      updateState((state) => {
        const row = state.reviewRows.find((item) => item.id === rowId);
        if (!row) return;
        if (action === "drop") {
          state.reviewRows = state.reviewRows.filter((item) => item.id !== rowId);
          state.parseLog.unshift(`Dropped review item: ${row.item}`);
          return;
        }
        row.risk = "approved";
        row.action = "applied";
        state.parseLog.unshift(`Approved AI action: ${row.item}`);
      });
    }
    if (table === "import") {
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
  });
}

function setTable(selector, columns, rows, options = {}) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.innerHTML = renderTable(columns, rows, options);
}
