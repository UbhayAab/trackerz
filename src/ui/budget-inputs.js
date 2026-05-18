import { updateState } from "../state/app-state.js";
import { upsertBudget, fetchBudgets } from "../services/supabase-data.js";

const PERIOD_BY_LABEL = {
  "Monthly spend cap": "monthly",
  "Weekly spend cap": "weekly",
  "Food delivery cap": "monthly",
  "Calorie target": "daily",
  "Protein target": "daily",
  "Daily safe-spend": "daily",
};

let saveTimers = new WeakMap();

export function bindBudgetInputs(statusId) {
  const status = document.querySelector(`#${statusId}`);
  document.querySelectorAll("input[type='number']").forEach((input) => {
    input.addEventListener("input", () => {
      const label = input.closest("label")?.querySelector("span")?.textContent || "Budget";
      if (status) status.textContent = `${label} set to ${input.value}. Saving...`;
      updateState((state) => {
        state.parseLog.unshift(`${label} updated to ${input.value}.`);
      });

      clearTimeout(saveTimers.get(input));
      const t = setTimeout(async () => {
        const amount = Number(input.value);
        if (!amount || !Number.isFinite(amount)) return;
        const period = PERIOD_BY_LABEL[label] || "monthly";
        try {
          await upsertBudget({
            period,
            amount,
            startsOn: monthStartIsoDate(),
          });
          if (status) status.textContent = `${label} saved (${period}).`;
        } catch (err) {
          if (status) status.textContent = `${label} save failed: ${err.message || err}`;
        }
      }, 600);
      saveTimers.set(input, t);
    });
  });

  void hydrateBudgetInputs();
}

async function hydrateBudgetInputs() {
  try {
    const budgets = await fetchBudgets();
    if (!budgets.length) return;
  } catch {
    // Silent — budgets are optional.
  }
}

function monthStartIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
