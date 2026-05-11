import { $ } from "../utils/dom.js";
import { budgetRows, importRows, ledgerRows, macroRows, reviewRows } from "../data/table-data.js";
import { renderTable } from "./table-renderer.js";

const reviewColumns = [
  { key: "item", label: "Item", strong: true },
  { key: "domain", label: "Domain", badge: true },
  { key: "confidence", label: "Conf." },
  { key: "risk", label: "Risk", badge: true },
  { key: "action", label: "Action" },
];

const importColumns = [
  { key: "file", label: "File", strong: true },
  { key: "rows", label: "Rows" },
  { key: "mapped", label: "Mapped" },
  { key: "duplicate", label: "Dupes" },
  { key: "status", label: "Status", badge: true },
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

export function renderOperationalTables() {
  $("#reviewTable").innerHTML = renderTable(reviewColumns, reviewRows);
  $("#importTable").innerHTML = renderTable(importColumns, importRows);
  $("#ledgerTable").innerHTML = renderTable(ledgerColumns, ledgerRows);
  $("#budgetTable").innerHTML = renderTable(budgetColumns, budgetRows);
  $("#macroTable").innerHTML = renderTable(macroColumns, macroRows);
}
