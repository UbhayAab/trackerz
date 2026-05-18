import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderOperationalTables } from "../ui/operational-tables.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

bootWithAuth(async () => {
  subscribe((state) => {
    renderMetrics(state);
    renderOperationalTables(state);
    renderInsights(state);
    renderSummaryRail(state);
  });
  bindInsights();
  bindBudgetInputs("dietBudgetStatus");
  await hydrateStateFromSupabase();
});
