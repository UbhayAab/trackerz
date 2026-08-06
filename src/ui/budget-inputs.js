// Budget / goal editor - bound to the single keyed source (the `budgets` table,
// one row per kind). Inputs declare their goal with `data-budget-kind`. On edit
// it upserts that kind and RE-HYDRATES the whole app, so the new value shows up
// everywhere it's read (Home glance, Money page, the diet hub targets, insights).
// No page holds its own copy of a budget.

import { upsertBudget } from "../services/supabase-data.js";
import { goalDef, goalValue, goalDisplayValue, resolveDietTargets } from "../domain/goals.js";
import { planForDate } from "../domain/diet/plan.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { refreshAfterWrite } from "./refresh.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";

const saveTimers = new WeakMap();

function canSync() {
  return Boolean(getCurrentSession()?.user?.id) && !isLocalSession();
}

// Fill every budget input on the page from the single source (set value, else the
// seed default). Call this on every state change so edits made elsewhere appear.
export function renderBudgetInputs(state) {
  const budgets = state?.budgets || [];
  // Diet inputs show the EFFECTIVE target (set goal, else the scaffold-derived
  // value) so the input always matches the gauges/cards - never an input that
  // disagrees with the target shown elsewhere.
  const dt = resolveDietTargets(budgets, planForDate(new Date()).macroTargets);
  document.querySelectorAll("input[data-budget-kind]").forEach((input) => {
    if (input.matches(":focus")) return; // don't fight the user mid-type
    const kind = input.dataset.budgetKind;
    let v;
    if (kind === "daily_calories") v = dt.calories;
    else if (kind === "daily_protein") v = dt.protein_g;
    else if (kind === "weekly_calories") v = goalValue(budgets, kind) ?? Math.round(dt.calories * 7);
    else if (isUnsetGoal(budgets, kind)) {
      // An unsaved goal is in effect NOWHERE - the brief, the trajectory table
      // and the insight rules all read the budgets row, not the seed. So show the
      // seed as a placeholder (visibly unset) instead of a value that claims a
      // target the app isn't enforcing.
      //
      // This used to cover money caps only, so the gym box rendered a filled-in
      // "4" that was indistinguishable from a saved value while the budgets table
      // held no weekly_workouts row at all. The two consumers then disagreed: the
      // Gym page fell back to 4 and showed "/4", while the Analytics gym card read
      // the same missing row as null and dropped the target entirely.
      const def = goalDef(kind);
      input.value = "";
      input.placeholder = def?.default != null ? `Not set (using ${def.default})` : "Not set";
      return;
    } else v = goalDisplayValue(budgets, kind);
    if (v != null) input.value = v;
  });
}

// Any goal with no saved row. Diet targets are excluded because the branches
// above resolve them from the diet scaffold, which IS what the app enforces when
// nothing is set - so for those the seed is the honest answer, not a claim.
function isUnsetGoal(budgets, kind) {
  return goalValue(budgets, kind) == null;
}

export function bindBudgetInputs(statusId) {
  const status = statusId ? document.querySelector(`#${statusId}`) : null;
  document.querySelectorAll("input[data-budget-kind]").forEach((input) => {
    if (input.dataset.budgetBound) return;
    input.dataset.budgetBound = "1";
    input.addEventListener("input", () => {
      const def = goalDef(input.dataset.budgetKind);
      const label = def?.label || "Budget";
      if (status) status.textContent = `${label} → ${input.value}. Saving…`;
      clearTimeout(saveTimers.get(input));
      const t = setTimeout(() => saveBudget(input, status), 600);
      saveTimers.set(input, t);
    });
  });
}

async function saveBudget(input, status) {
  const def = goalDef(input.dataset.budgetKind);
  if (!def) return;
  const amount = Number(input.value);
  // Bailing silently left the status reading "Saving…" forever on a blank/zero
  // input, so nothing was saved but the UI said otherwise.
  if (!Number.isFinite(amount) || amount <= 0) {
    // Emptying the box does NOT remove a saved cap - the budgets row is still
    // there. Saying "cleared, no cap is in effect" would be its own false
    // assertion, which is the bug class this whole pass is about.
    if (status) status.textContent = input.value.trim() === ""
      ? `${def.label} unchanged - clearing the box doesn't remove a saved cap. Enter a number to change it.`
      : `${def.label} not saved - enter a number above 0.`;
    return;
  }
  if (!canSync()) { if (status) status.textContent = "Sign in to save budgets."; return; }
  try {
    await upsertBudget({ kind: def.kind, period: def.period, amount });
    if (status) status.textContent = `${def.label} saved - updated everywhere.`;
    // Re-hydrate so every surface that reads this budget/goal refreshes.
    await refreshAfterWrite("the target");
  } catch (err) {
    if (status) status.textContent = `${def.label} save failed: ${err?.message || err}`;
  }
}
