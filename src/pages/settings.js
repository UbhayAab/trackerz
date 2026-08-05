import { bindCostMeter, renderCostMeter } from "../ui/cost-meter.js";
import { bindDataControls } from "../ui/data-controls.js";
import { bindBudgetInputs, renderBudgetInputs } from "../ui/budget-inputs.js";
import { bindJarvisCard } from "../ui/jarvis-settings.js";
import { mountAccountPanel } from "../ui/account-panel.js";
import { mountHealthPanel } from "../ui/health-panel.js";
import { mountSpendCapturePanel } from "../ui/spend-capture-panel.js";
import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { registerServiceWorker } from "../services/pwa.js";
import { subscribe } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { loadReminders, bindRemindersPanel } from "../ui/reminders-panel.js";

// Settings is where push gets turned on, and there is no subscription without a
// service worker - this page never registered one, so navigator.serviceWorker.ready
// hung forever and push_subscriptions stayed empty.
registerServiceWorker();

bootWithAuth(async () => {
  renderNav("settings");
  renderCostMeter();
  bindCostMeter();
  bindBudgetInputs("settingsStatus");
  // The calorie/protein/workout goals moved here from the deleted Diet page.
  // bindBudgetInputs only wires the save handler - renderBudgetInputs is what
  // fills the boxes from the budgets table, and this page previously did
  // neither hydrate nor subscribe, so without these two lines every goal box
  // would render blank and look unset.
  subscribe((state) => renderBudgetInputs(state));
  bindJarvisCard();
  bindDataControls();
  mountAccountPanel();
  // Health Connect (watch sleep/steps). In a plain browser this renders an
  // honest "Android app only" state; the bridge only exists inside the APK.
  mountHealthPanel();
  // Automatic spend capture from payment notifications + bank SMS. Honest "Android
  // app only" fallback in a browser; inside the APK the user grants access once and
  // every payment is logged without changing how they pay.
  mountSpendCapturePanel();
  // Recurring reminders: the list, plus pause/delete. Created by capture, not
  // here - the point of the feature is that you say it once out loud.
  bindRemindersPanel();
  loadReminders();
  await hydrateStateFromSupabase();
});
