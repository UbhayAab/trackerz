import { resetWorkspace } from "../state/app-state.js";

export function bindDataControls() {
  const clearButton = document.querySelector("#clearWorkspace");
  const demoButton = document.querySelector("#loadDemoData");
  const status = document.querySelector("#dataStatus");
  if (!clearButton || !demoButton || !status) return;

  clearButton.addEventListener("click", () => {
    resetWorkspace("empty");
    status.textContent = "cleared";
  });

  demoButton.addEventListener("click", () => {
    resetWorkspace("demo");
    status.textContent = "demo loaded";
  });
}
