import { bindCapturePanel, renderRoutePreview } from "../ui/capture-panel.js";
import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderAdditionsFeed, bindAdditionsFeed } from "../ui/additions-feed.js";
import { renderDietPlan, bindDietPlan } from "../ui/diet-plan-panel.js";
import { renderAgentStatus } from "../ui/agent-status.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderNav } from "../ui/navigation.js";
import { subscribe, getState } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { registerServiceWorker, bindInstallPrompt, bindOnlineDrain } from "../services/pwa.js";
import { runCapture } from "../services/agent-runner.js";
import { ensureTodayBriefing } from "../services/briefing.js";
import { renderBriefingStrip } from "../ui/briefing-strip.js";

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
    renderDietPlan(state);
  });
  bindCapturePanel();
  bindInsights();
  bindAdditionsFeed();
  bindDietPlan();
  renderDietPlan();
  bindOnlineDrain(runCapture);
  await hydrateStateFromSupabase();
  // Proactive briefing: generated once per slot/day from the freshly hydrated
  // state, then shown at the top of Home. Best-effort — silent when offline.
  try {
    const briefing = await ensureTodayBriefing(getState(), new Date());
    renderBriefingStrip(document.getElementById("briefingStrip"), briefing);
  } catch { /* briefing is a nudge, never block the page */ }
});
