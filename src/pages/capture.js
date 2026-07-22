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
import { ensureTodayBriefing, watchTodayBriefings } from "../services/briefing.js";
import { renderBriefingStrip } from "../ui/briefing-strip.js";
import { bindQuickActions } from "../ui/quick-actions.js";

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
  bindQuickActions();
  bindInsights();
  bindAdditionsFeed();
  bindDietPlan();
  renderDietPlan();
  bindOnlineDrain(runCapture);
  await hydrateStateFromSupabase();
  // Proactive briefing: the jarvis edge fn writes it server-side on schedule —
  // show the freshest row (client-generating only as offline fallback), and
  // keep the strip live so a brief landing mid-session appears immediately.
  try {
    const host = document.getElementById("briefingStrip");
    const briefing = await ensureTodayBriefing(getState(), new Date());
    renderBriefingStrip(host, briefing);
    watchTodayBriefings((row) => renderBriefingStrip(host, row));
  } catch { /* briefing is a nudge, never block the page */ }
});
