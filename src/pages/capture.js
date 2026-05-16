import { bindCapturePanel, renderRoutePreview } from "../ui/capture-panel.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { bindOperationalTables, renderOperationalTables } from "../ui/operational-tables.js";
import { renderAgentStatus } from "../ui/agent-status.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { subscribe } from "../state/app-state.js";

function bootCapturePage() {
  renderRoutePreview();
  subscribe((state) => {
    renderAgentStatus(state);
    renderOperationalTables(state);
    renderInsights(state);
    renderMetrics(state);
    renderSummaryRail(state);
  });
  bindCapturePanel();
  bindInsights();
  bindOperationalTables();
}

bootCapturePage();
