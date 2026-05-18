import { bindOperationalTables, renderOperationalTables } from "../ui/operational-tables.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { renderSummaryRail } from "../ui/summary-rail.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { bindStatementImporter } from "../ui/statement-importer.js";

bootWithAuth(async () => {
  subscribe((state) => {
    renderOperationalTables(state);
    renderSummaryRail(state);
  });
  bindOperationalTables();
  bindBudgetInputs("moneyBudgetStatus");
  bindStatementImporter();
  await hydrateStateFromSupabase();
});
