// REPEAT CHIPS - the fix for "why am I typing the same meal every day".
//
// The user eats a small rotating set of things. Until now every one of them cost a
// typed sentence and a 5-15s model round-trip that re-estimated macros the app had
// already estimated. These chips are built from the user's OWN food history
// (lib/meal-repeats.mjs), so one tap writes a complete row with known macros: no
// Gemini, no DeepSeek, no wait, no cost.
//
// Deliberately silent when there is nothing to offer. A chip row that shows up empty
// or shows meals with unknown calories would be worse than no chips at all - tapping
// one would write a silent zero into the day's totals.

import { fetchFoodLogs, logRepeatMeal } from "../services/supabase-data.js";
import { topRepeatMeals } from "../../lib/meal-repeats.mjs";
import { showToast } from "./toast.js";

const HOST_ID = "mealChips";

let state = { chips: [], busy: false, loaded: false, error: null };
let onLogged = null;

function host() {
  return document.getElementById(HOST_ID);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// "6 boiled eggs" is already short. Anything long gets clipped with a title so the
// full text is still reachable on long-press / hover.
function chipLabel(text) {
  const t = String(text || "").trim();
  return t.length > 34 ? `${t.slice(0, 33)}…` : t;
}

// Why this chip is being offered, in the user's own terms. A repeat chip is a meal
// he logged verbatim N times; a combo chip is a pairing he kept eating on N
// separate days even though the rest of the plate changed. Saying which is the
// difference between a suggestion and a guess, and it is cheap to say.
function chipReason(c) {
  if (c.kind === "combo") {
    return `you've had this ${c.days} days recently`;
  }
  return `logged ${c.count} times`;
}

export function renderMealChips() {
  const el = host();
  if (!el) return;

  if (state.error) {
    // A failed read is NOT "you have no repeats" - say which it is.
    el.hidden = false;
    el.innerHTML = `<p class="chips-error">Couldn't load your usual meals: ${escapeHtml(state.error)}</p>`;
    return;
  }
  if (!state.loaded || !state.chips.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }

  el.hidden = false;
  el.innerHTML = `
    <p class="chips-label">Log again</p>
    <div class="chip-row" role="group" aria-label="Repeat a meal you have logged before">
      ${state.chips.map((c, i) => `
        <button type="button" class="meal-chip" data-idx="${i}"
                data-kind="${escapeHtml(c.kind || "repeat")}"
                data-label="${escapeHtml(c.label)}"
                title="${escapeHtml(c.label)} · ${escapeHtml(chipReason(c))}"
                aria-label="Log ${escapeHtml(c.label)}, ${c.calories_estimate} calories, ${escapeHtml(chipReason(c))}">
          <span class="meal-chip-name">${escapeHtml(chipLabel(c.label))}</span>
          <span class="meal-chip-macros">${Math.round(c.calories_estimate)} kcal${
            c.protein_g === null ? "" : ` · ${Math.round(c.protein_g)}g P`
          }</span>
        </button>`).join("")}
    </div>
  `;
}

export async function refreshMealChips() {
  const el = host();
  if (!el) return;
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
  }
  renderMealChips();
}

export function bindMealChips({ afterLog = null } = {}) {
  const el = host();
  if (!el) return;
  onLogged = afterLog;

  el.addEventListener("click", async (event) => {
    const btn = event.target.closest("button.meal-chip");
    if (!btn || state.busy) return;
    const chip = state.chips[Number(btn.dataset.idx)];
    if (!chip) return;

    state.busy = true;
    btn.disabled = true;
    try {
      await logRepeatMeal(chip);
      showToast(`Logged ${chip.label} - ${Math.round(chip.calories_estimate)} kcal.`);
      // Re-rank immediately: the meal just eaten should move, and the caller
      // refreshes the day's totals so the numbers on screen agree at once.
      await refreshMealChips();
      if (typeof onLogged === "function") await onLogged();
    } catch (err) {
      // Loud on failure. A quick action that fails quietly is why the app used to
      // look like it had logged something when it had not.
      showToast(`Didn't log it: ${err?.message || err}`, { kind: "error", duration: 5000 });
    } finally {
      state.busy = false;
      btn.disabled = false;
    }
  });

  refreshMealChips();
}
