import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { renderInsights } from "../ui/insights-panel.js";
import { subscribe } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

// Analytics is the tucked-away deep page. P1 ships the shell + the insight feed;
// strength/volume/recomp/trajectory charts land in P4.
bootWithAuth(async () => {
  renderNav("analytics");
  subscribe((state) => renderInsights(state));
  await hydrateStateFromSupabase();
});
