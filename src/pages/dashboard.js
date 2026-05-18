import { bindViewTabs, renderCharts } from "../ui/charts.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderOperationalTables } from "../ui/operational-tables.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

bootWithAuth(async () => {
  subscribe((state) => {
    renderCharts(undefined, state);
    renderOperationalTables(state);
    renderInsights(state);
    renderSummaryRail(state);
  });
  bindViewTabs();
  bindInsights();
  await hydrateStateFromSupabase();
});
