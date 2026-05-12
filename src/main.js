import { bindCapturePanel, renderRoutePreview } from "./ui/capture-panel.js";
import { renderCostMeter, bindCostMeter } from "./ui/cost-meter.js";
import { renderFlowLab, bindFlowLab } from "./ui/flow-lab.js";
import { renderCharts, bindViewTabs } from "./ui/charts.js";
import { bindInsights, renderInsights } from "./ui/insights-panel.js";
import { renderPipeline } from "./ui/pipeline.js";
import { bindOperationalTables, renderOperationalTables } from "./ui/operational-tables.js";
import { renderAgentStatus } from "./ui/agent-status.js";
import { renderMetrics } from "./ui/metrics.js";
import { bindNavigation } from "./ui/navigation.js";
import { bindSettingsPanel } from "./ui/settings-panel.js";
import { subscribe } from "./state/app-state.js";

function boot() {
  renderPipeline();
  renderCharts("dod");
  renderCostMeter();
  renderFlowLab("all");
  renderRoutePreview();

  subscribe((state) => {
    renderAgentStatus(state);
    renderOperationalTables(state);
    renderInsights(state);
    renderMetrics(state);
  });

  bindCapturePanel();
  bindCostMeter();
  bindFlowLab();
  bindViewTabs();
  bindInsights();
  bindOperationalTables();
  bindNavigation();
  bindSettingsPanel();
}

boot();
