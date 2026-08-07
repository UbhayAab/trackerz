// Budget / goal editor - bound to the single keyed source (the `budgets` table,
// one row per kind). Inputs declare their goal with `data-budget-kind`. On edit
// it upserts that kind and RE-HYDRATES the whole app, so the new value shows up
// everywhere it's read (Home glance, Money page, the diet hub targets, insights).
// No page holds its own copy of a budget.

import { upsertBudget } from "../services/supabase-data.js";
import { goalDef, goalValue, resolveDietTargets } from "../domain/goals.js";
import { planForDate } from "../domain/diet/plan.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { refreshAfterWrite } from "./refresh.js";
import { getCurrentSession, isLocalSession } from "../services/auth.js";

const saveTimers = new WeakMap();

function canSync() {
  return Boolean(getCurrentSession()?.user?.id) && !isLocalSession();
}

// The number actually IN FORCE for a kind when the user has saved nothing.
//
// For diet kinds this is the scaffold-derived target the whole app enforces
// (resolveDietTargets), not the static seed in GOALS - the two can differ once
// the diet plan changes, and showing the seed would name a number no gauge uses.
export function effectiveDefault(kind, dietTargets) {
  const dt = dietTargets || {};
  if (kind === "daily_calories") return dt.calories == null ? null : Math.round(dt.calories);
  if (kind === "daily_protein") return dt.protein_g == null ? null : Math.round(dt.protein_g);
  if (kind === "weekly_calories") return dt.calories == null ? null : Math.round(dt.calories * 7);
  return goalDef(kind)?.default ?? null;
}

// Fill every budget input on the page from the single source (set value, else the
// seed default). Call this on every state change so edits made elsewhere appear.
export function renderBudgetInputs(state) {
  const budgets = state?.budgets || [];
  const dt = resolveDietTargets(budgets, planForDate(new Date()).macroTargets);
  document.querySelectorAll("input[data-budget-kind]").forEach((input) => {
    if (input.matches(":focus")) return; // don't fight the user mid-type
    const kind = input.dataset.budgetKind;

    const saved = goalValue(budgets, kind);
    if (saved != null) {
      input.value = saved;
      input.placeholder = "";
      return;
    }

    // NOTHING SAVED. Show the value in force as a PLACEHOLDER and leave the box
    // empty, so it cannot be mistaken for a number he chose.
    //
    // Diet targets used to be excluded from this branch and rendered as a filled
    // in value instead, on the reasoning that the scaffold number really is
    // enforced so printing it is honest. Enforcement was never the issue. The
    // `budgets` table has held ZERO rows for the entire life of this app
    // (verified against the live DB 2026-08-08), so the 162 g in that box was
    // always the scaffold's, never his - and with the box filled in there was no
    // way to tell those two apart. Every surface then reported it back as "your
    // target" and the briefs scolded him for missing it, 0 hits in 20 logged
    // days. A default is a fine starting point; presenting it as the user's own
    // decision is the app inventing a fact and then holding him to it.
    const inForce = effectiveDefault(kind, dt);
    input.value = "";
    input.placeholder = inForce != null ? `Not set (using ${inForce})` : "Not set";
  });
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
