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
import { bindQuickActions, refreshQuickActions } from "../ui/quick-actions.js";
import { bindMealChips, refreshMealChips } from "../ui/meal-chips.js";
import { loadReminders } from "../ui/reminders-panel.js";

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
    // A capture that logged gym/water/sleep must be reflected in the one-tap row
    // above, or it reads "unanswered" and gets tapped again - that is how a real
    // duplicate workout row was created on 2026-07-22. Coalesced internally.
    refreshQuickActions();
    refreshMealChips();
  });
  // A capture can CREATE a reminder ("my birthday is 14 August"), so the strip is
  // reloaded after every capture, not just on first paint.
  loadReminders();
  bindCapturePanel();
  bindQuickActions();
  // One tap re-logs a meal from your own history with its median macros - no model
  // call, no wait. Refreshing state afterwards keeps the day's totals in step.
  bindMealChips({ afterLog: () => hydrateStateFromSupabase() });
  bindInsights();
  bindAdditionsFeed();
  bindDietPlan();
  renderDietPlan();
  bindOnlineDrain(runCapture);
  await hydrateStateFromSupabase();
  // Proactive briefing: the jarvis edge fn writes it server-side on schedule -
  // show the freshest row (client-generating only as offline fallback), and
  // keep the strip live so a brief landing mid-session appears immediately.
  try {
    const host = document.getElementById("briefingStrip");
    const briefing = await ensureTodayBriefing(getState(), new Date());
    renderBriefingStrip(host, briefing);
    watchTodayBriefings((row) => renderBriefingStrip(host, row));
  } catch { /* briefing is a nudge, never block the page */ }
});
