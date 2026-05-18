import { resetWorkspace } from "../state/app-state.js";

export function bindDataControls() {
  const clearButton = document.querySelector("#clearWorkspace");
  const status = document.querySelector("#dataStatus");
  if (!clearButton || !status) return;

  clearButton.addEventListener("click", () => {
    resetWorkspace("empty");
    status.textContent = "cleared";
  });
}
