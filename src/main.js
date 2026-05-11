import { bindCapturePanel, renderRoutePreview } from "./ui/capture-panel.js";
import { renderCostMeter, bindCostMeter } from "./ui/cost-meter.js";
import { renderFlowLab, bindFlowLab } from "./ui/flow-lab.js";
import { renderCharts, bindViewTabs } from "./ui/charts.js";
import { renderInsights } from "./ui/insights-panel.js";
import { renderPipeline } from "./ui/pipeline.js";
import { renderOperationalTables } from "./ui/operational-tables.js";

function boot() {
  renderPipeline();
  renderCharts("dod");
  renderInsights();
  renderCostMeter();
  renderFlowLab("all");
  renderOperationalTables();
  renderRoutePreview();

  bindCapturePanel();
  bindCostMeter();
  bindFlowLab();
  bindViewTabs();
}

boot();
