import { bindCapturePanel, renderRoutePreview } from "../ui/capture-panel.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderAdditionsFeed, bindAdditionsFeed } from "../ui/additions-feed.js";
import { renderDietPlan, bindDietPlan } from "../ui/diet-plan-panel.js";
import { renderAgentStatus } from "../ui/agent-status.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderNav } from "../ui/navigation.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { registerServiceWorker, bindInstallPrompt, bindOnlineDrain } from "../services/pwa.js";
import { runCapture } from "../services/agent-runner.js";

registerServiceWorker();
bindInstallPrompt("installAppBtn");

bootWithAuth(async () => {
  renderNav("home");
  renderRoutePreview();
  subscribe((state) => {
    renderAgentStatus(state);
    renderAdditionsFeed(state);
    renderInsights(state);
    renderMetrics(state);
  });
  bindCapturePanel();
  bindInsights();
  bindAdditionsFeed();
  bindDietPlan();
  renderDietPlan();
  bindOnlineDrain(runCapture);
  await hydrateStateFromSupabase();
});
