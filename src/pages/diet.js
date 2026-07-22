import { bindInsights, renderInsights } from "../ui/insights-panel.js";
import { renderMetrics } from "../ui/metrics.js";
import { renderOperationalTables } from "../ui/operational-tables.js";
import { renderNav } from "../ui/navigation.js";
import { bindBudgetInputs, renderBudgetInputs } from "../ui/budget-inputs.js";
import { renderDietPlan, bindDietPlan } from "../ui/diet-plan-panel.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

// Diet domain helpers (Wave 4) - re-exported so the page module is the
// single import surface used by the diet UI layer.
export { computeMacroPace } from "../domain/diet/macro-pace.js";
export { suggestProteinFixes, PROTEIN_SOURCES } from "../domain/diet/protein-gap.js";
export { pickByName, pickByLastUsed, instantiate } from "../domain/diet/meal-templates.js";
export { computeEatingWindow } from "../domain/diet/eating-window.js";
export { detectLateSnackPattern } from "../domain/diet/late-snack-detector.js";
export { HOME_FOOD_PORTIONS, findHomeFood } from "../domain/diet/home-food-portions.js";
export { parseRestaurantBill } from "../domain/diet/restaurant-mode.js";
export { rollingWeightAverages } from "../domain/diet/weight-rolling-avg.js";

bootWithAuth(async () => {
  renderNav("diet");
  subscribe((state) => {
    renderMetrics(state);
    renderOperationalTables(state);
    renderInsights(state);
    renderBudgetInputs(state);
    // The day-navigable diet log (stepper + calendar + swipe strip). Same panel as
    // the Home hub - additive here so the dedicated Diet page can reach past days.
    renderDietPlan(state);
  });
  bindInsights();
  bindBudgetInputs("dietBudgetStatus");
  bindDietPlan();
  renderDietPlan(); // first paint before state hydrates
  await hydrateStateFromSupabase();
});
