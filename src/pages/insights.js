import { bindFlowLab, renderFlowLab } from "../ui/flow-lab.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderScheduleList } from "../ui/schedule-list.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { subscribe } from "../state/app-state.js";

function bootInsightsPage() {
  renderFlowLab("all");
  renderScheduleList();
  subscribe((state) => {
    renderInsights(state);
    renderSummaryRail(state);
  });
  bindFlowLab();
  bindInsights();
}

bootInsightsPage();
