import { updateState } from "../state/app-state.js";

export function bindNightlySchedule() {
  const toggle = document.querySelector("#nightlySummaryToggle");
  const status = document.querySelector("#scheduleStatus");
  if (!toggle || !status) return;

  toggle.addEventListener("change", () => {
    status.textContent = toggle.checked ? "enabled" : "paused";
    updateState((state) => {
      state.parseLog.unshift(toggle.checked ? "12 AM summary enabled." : "12 AM summary paused.");
    });
  });

  document.querySelector("#autopilotToggle")?.addEventListener("change", (event) => {
    updateState((state) => {
      state.parseLog.unshift(event.target.checked ? "Autopilot enabled for safe rows." : "Autopilot disabled. Review-first mode active.");
    });
  });
}
