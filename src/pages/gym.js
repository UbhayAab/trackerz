import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { renderWorkoutPanel, bindWorkoutPanel } from "../ui/workout-panel.js";
import { subscribe } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

// Gym: detailed per-exercise set logging + body composition (P3).
bootWithAuth(async () => {
  renderNav("gym");
  bindWorkoutPanel();
  subscribe((state) => renderWorkoutPanel(state));
  renderWorkoutPanel(); // first paint from the plan before data arrives
  await hydrateStateFromSupabase();
});
