import { $ } from "../utils/dom.js";
import { updateState } from "../state/app-state.js";

export function bindSettingsPanel() {
  $("#settingsButton").addEventListener("click", () => {
    $("#settingsPanel").hidden = false;
  });

  $("#closeSettings").addEventListener("click", () => {
    $("#settingsPanel").hidden = true;
  });

  $("#autopilotToggle").addEventListener("change", (event) => {
    const enabled = event.target.checked;
    $("#settingsStatus").textContent = enabled
      ? "Autopilot can create safe rows, but risky rows stay in review."
      : "Autopilot off. Every AI write will wait in review.";
    updateState((state) => {
      state.parseLog.unshift(enabled ? "Autopilot enabled for safe rows." : "Autopilot disabled. Review-first mode active.");
    });
  });

  $("#dailyCapInput").addEventListener("input", (event) => {
    updateState((state) => {
      state.parseLog.unshift(`Daily AI cap set to $${event.target.value || 0}.`);
    });
  });
}
