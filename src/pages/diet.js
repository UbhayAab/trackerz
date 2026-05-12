import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderOperationalTables } from "../ui/operational-tables.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { subscribe } from "../state/app-state.js";

function bootDietPage() {
  subscribe((state) => {
    renderMetrics(state);
    renderOperationalTables(state);
    renderInsights(state);
  });
  bindInsights();
  bindBudgetInputs("dietBudgetStatus");
}

bootDietPage();
