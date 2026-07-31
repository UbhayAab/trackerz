import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { renderGymToday, bindGymToday } from "../ui/gym-today.js";
import { renderWorkoutPanel, bindWorkoutPanel } from "../ui/workout-panel.js";
import { renderGymInsights } from "../ui/gym-insights-panel.js";
import { subscribe } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

// Gym. Leads with how workouts are really logged - one tap for went/skipped and
// one line of free text or voice that the AI structures. The per-exercise
// checklist is still here, collapsed, for a day you want to drive it that way.
//
// The weekly-workouts goal input used to live on this page as well as being a
// budget; it now sits with every other budget in Settings, so there is one
// editor for it. The target still shows here, as a number, in the header badge
// and in the intelligence panel.
bootWithAuth(async () => {
  renderNav("gym");
  bindGymToday();
  bindWorkoutPanel();
  subscribe((state) => {
    renderGymToday(state);
    renderWorkoutPanel(state);
    renderGymInsights(state);
  });
  renderGymToday();     // first paint from the plan before data arrives
  renderWorkoutPanel();
  await hydrateStateFromSupabase();
});
