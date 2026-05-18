import { bindCostMeter, renderCostMeter } from "../ui/cost-meter.js";
import { bindDataControls } from "../ui/data-controls.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { bindNightlySchedule } from "../ui/nightly-schedule.js";
import { bootWithAuth } from "./bootstrap.js";

bootWithAuth(() => {
  renderCostMeter();
  bindCostMeter();
  bindBudgetInputs("settingsStatus");
  bindNightlySchedule();
  bindDataControls();
});
