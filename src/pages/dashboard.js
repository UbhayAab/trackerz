import { bindViewTabs, renderCharts } from "../ui/charts.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderOperationalTables } from "../ui/operational-tables.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { renderDashboards } from "../ui/dashboard-views.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { registerServiceWorker } from "../services/pwa.js";

registerServiceWorker();

bootWithAuth(async () => {
  subscribe((state) => {
    renderCharts(undefined, state);
    renderOperationalTables(state);
    renderInsights(state);
    renderSummaryRail(state);
    renderDashboards({
      ledger: state.ledger || [],
      foodLogs: state.foodLogs || [],
      wellnessLogs: state.wellnessLogs || [],
      bodyMetrics: state.bodyMetrics || [],
      budgets: state.budgets || [],
      subscriptions: state.subscriptions || [],
      today: new Date(),
    });
  });
  bindViewTabs();
  bindInsights();
  await hydrateStateFromSupabase();
});
