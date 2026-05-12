import { bindViewTabs, renderCharts } from "../ui/charts.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderOperationalTables } from "../ui/operational-tables.js";
import { subscribe } from "../state/app-state.js";

function bootDashboardPage() {
  renderCharts("dod");
  subscribe((state) => {
    renderOperationalTables(state);
    renderInsights(state);
  });
  bindViewTabs();
  bindInsights();
}

bootDashboardPage();
