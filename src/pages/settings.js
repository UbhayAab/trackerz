import { bindCostMeter, renderCostMeter } from "../ui/cost-meter.js";
import { bindDataControls } from "../ui/data-controls.js";
import { bindBudgetInputs } from "../ui/budget-inputs.js";
import { bindJarvisCard } from "../ui/jarvis-settings.js";
import { mountAccountPanel } from "../ui/account-panel.js";
import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { registerServiceWorker } from "../services/pwa.js";

// Settings is where push gets turned on, and there is no subscription without a
// service worker — this page never registered one, so navigator.serviceWorker.ready
// hung forever and push_subscriptions stayed empty.
registerServiceWorker();

bootWithAuth(() => {
  renderNav("settings");
  renderCostMeter();
  bindCostMeter();
  bindBudgetInputs("settingsStatus");
  bindJarvisCard();
  bindDataControls();
  mountAccountPanel();
});
