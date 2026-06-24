import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { renderInsights } from "../ui/insights-panel.js";
import { renderDashboards } from "../ui/dashboard-views.js";
import { subscribe } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

// Analytics: the deep page. Day/Week/Month tiles + 30-day spend sparkline +
// the ranked insight feed, all from live state.
bootWithAuth(async () => {
  renderNav("analytics");
  subscribe((state) => {
    renderDashboards({
      ledger: state.ledger || [],
      foodLogs: state.foodLogs || [],
      wellnessLogs: state.wellnessLogs || [],
      bodyMetrics: state.bodyMetrics || [],
      budgets: state.budgets || [],
      subscriptions: state.subscriptions || [],
      today: new Date(),
    });
    renderInsights(state);
  });
  await hydrateStateFromSupabase();
});
