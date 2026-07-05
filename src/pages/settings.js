import { bindCostMeter, renderCostMeter } from "../ui/cost-meter.js";
import { bindDataControls } from "../ui/data-controls.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { bindJarvisCard } from "../ui/jarvis-settings.js";
import { mountAccountPanel } from "../ui/account-panel.js";
import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";

bootWithAuth(() => {
  renderNav("settings");
  renderCostMeter();
  bindCostMeter();
  bindBudgetInputs("settingsStatus");
  bindJarvisCard();
  bindDataControls();
  mountAccountPanel();
});
