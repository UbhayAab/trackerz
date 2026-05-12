import { updateState } from "../state/app-state.js";

export function bindBudgetInputs(statusId) {
  const status = document.querySelector(`#${statusId}`);
  document.querySelectorAll("input[type='number']").forEach((input) => {
    input.addEventListener("input", () => {
      const label = input.closest("label")?.querySelector("span")?.textContent || "Budget";
      if (status) status.textContent = `${label} set to ${input.value}. Nightly summary will use this target.`;
      updateState((state) => {
        state.parseLog.unshift(`${label} updated to ${input.value}.`);
      });
    });
  });
}
