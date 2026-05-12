import { bindOperationalTables, renderOperationalTables } from "../ui/operational-tables.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { subscribe } from "../state/app-state.js";

function bootMoneyPage() {
  subscribe((state) => renderOperationalTables(state));
  bindOperationalTables();
  bindBudgetInputs("moneyBudgetStatus");
}

bootMoneyPage();
