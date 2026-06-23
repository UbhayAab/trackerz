import { bindCostMeter, renderCostMeter } from "../ui/cost-meter.js";
import { bindDataControls } from "../ui/data-controls.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { bindNightlySchedule } from "../ui/nightly-schedule.js";
import { mountAccountPanel } from "../ui/account-panel.js";
import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";

bootWithAuth(() => {
  renderNav("settings");
  renderCostMeter();
  bindCostMeter();
  bindBudgetInputs("settingsStatus");
  bindNightlySchedule();
  bindDataControls();
  mountAccountPanel();
});
