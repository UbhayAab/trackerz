import { bindFlowLab, renderFlowLab } from "../ui/flow-lab.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderScheduleList } from "../ui/schedule-list.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { subscribe } from "../state/app-state.js";
import { renderOpportunityCost } from "../ui/opportunity-cost.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

bootWithAuth(async () => {
  renderFlowLab("all");
  renderScheduleList();
  subscribe((state) => {
    renderInsights(state);
    renderSummaryRail(state);
    renderOpportunityCost(state);
  });
  bindFlowLab();
  bindInsights();
  await hydrateStateFromSupabase();
});
