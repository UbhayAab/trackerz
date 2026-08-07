// YOUR USUALS - the fix for "why am I typing the same meal every day".
//
// The user eats a small rotating set of things. Until now every one of them cost
// a typed sentence and a 5-15s model round-trip that re-estimated macros the app
// had already estimated. These are built from the user's OWN food history
// (lib/meal-repeats.mjs), so one tap writes a complete row with known macros: no
// Gemini, no DeepSeek, no wait, no cost.
//
// WHERE THEY RENDER, AND WHY THAT CHANGED.
//
// This module used to own a "Log again" chip strip pinned near the top of Home:
// a second, differently-shaped list of meals sitting above the one list of meals
// the user actually works from. He asked three separate times for it to be part
// of the plan instead, and he was right. The plan section is where meals get
// ticked off; a suggested meal you cannot tick there is in the wrong place, and
// a second list is one more thing to read before finding the first.
//
// So this module is now a DATA PROVIDER. It ranks the history and hands the
// result to the plan panel, which renders them as ordinary checkbox rows under
// the planned meals. The strip, its markup and its host element are gone.
//
// Deliberately silent when there is nothing to offer. A suggestion with unknown
// calories would be worse than none at all - ticking it would write a silent
// zero into the day's totals.

import { fetchFoodLogs, logRepeatMeal } from "../services/supabase-data.js";
import { topRepeatMeals } from "../../lib/meal-repeats.mjs";
import { setUsualMeals, renderDietPlan } from "./diet-plan-panel.js";
import { showToast } from "./toast.js";

let state = { chips: [], loaded: false, error: null };
let onLogged = null;

/** What the plan panel is currently offering. Exported for tests. */
export function usualMeals() {
  return state.chips.slice();
}

/**
 * Re-rank from the user's food history and hand the result to the plan.
 *
 * A failed read is NOT "you have no usuals". It clears the list rather than
 * leaving a stale one on screen, and says so once - offering meals derived from
 * a read that failed is how a suggestion becomes a guess.
 */
export async function refreshMealChips() {
  try {
    const rows = await fetchFoodLogs({ limit: 200 });
    state.chips = topRepeatMeals(rows, { now: new Date(), limit: 5 });
    state.error = null;
    state.loaded = true;
  } catch (err) {
    // Not signed in is a normal state on this page, not an error worth shouting.
    const msg = err?.message || String(err);
    state.error = msg === "not_authenticated" ? null : msg;
    state.chips = [];
    state.loaded = true;
    if (state.error) showToast(`Couldn't load your usual meals: ${state.error}`, { kind: "error" });
  }
  setUsualMeals(state.chips);
  renderDietPlan();
}

/**
 * Log one usual. Called by the plan panel's checkbox handler.
 *
 * Throws on failure so the caller can un-tick the box: a tick that stays ticked
 * after a failed write is the exact lie this codebase keeps having to remove.
 */
export async function logUsualMeal(chip) {
  await logRepeatMeal(chip);
  showToast(`Logged ${chip.label} - ${Math.round(chip.calories_estimate)} kcal.`);
  // Re-rank immediately: the meal just eaten should move, and the caller
  // refreshes the day's totals so the numbers on screen agree at once.
  await refreshMealChips();
  if (typeof onLogged === "function") await onLogged();
}

export function bindMealChips({ afterLog = null } = {}) {
  onLogged = afterLog;
  // The click handling lives in the plan panel, next to the rows it draws.
  refreshMealChips();
}
