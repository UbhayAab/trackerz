import { bindOperationalTables, renderOperationalTables } from "../ui/operational-tables.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { renderNav } from "../ui/navigation.js";
import { subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { bindStatementImporter } from "../ui/statement-importer.js";

bootWithAuth(async () => {
  renderNav("money");
  subscribe((state) => {
    renderOperationalTables(state);
  });
  bindOperationalTables();
  bindBudgetInputs("moneyBudgetStatus");
  bindStatementImporter();
  await hydrateStateFromSupabase();
});
