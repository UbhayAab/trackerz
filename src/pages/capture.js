import { bindCapturePanel, renderRoutePreview } from "../ui/capture-panel.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { bindOperationalTables, renderOperationalTables } from "../ui/operational-tables.js";
import { bindQuickLog, renderQuickLog } from "../ui/quick-log.js";
import { renderDietPlan, bindDietPlan } from "../ui/diet-plan-panel.js";
import { renderAgentStatus } from "../ui/agent-status.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { registerServiceWorker, bindInstallPrompt, bindOnlineDrain } from "../services/pwa.js";
import { runCapture } from "../services/agent-runner.js";

registerServiceWorker();
bindInstallPrompt("installAppBtn");

bootWithAuth(async () => {
  renderRoutePreview();
  subscribe((state) => {
    renderAgentStatus(state);
    renderOperationalTables(state);
    renderInsights(state);
    renderMetrics(state);
    renderSummaryRail(state);
    renderQuickLog(state);
  });
  bindCapturePanel();
  bindInsights();
  bindOperationalTables();
  bindQuickLog();
  bindDietPlan();
  renderDietPlan();
  bindOnlineDrain(runCapture);
  await hydrateStateFromSupabase();
});
