// REPEAT SPEND CHIPS - the money half of "stop making me type what you already know".
//
// The database says this plainly: 14 ledger rows in seven months, every one of
// them hand-typed prose, every one with source_type null. Money tracking is dead
// because logging a spend costs a sentence and a 5-15 second model round-trip.
//
// lib/spend-patterns.mjs already learns the recurring ones - it finds "egg + roti,
// Rs 110, 4 times, usually 12:22" out of the real history. That engine was only
// ever reachable for a few seconds immediately after a capture, on one page
// (src/ui/spend-suggestion.js). This makes it a standing control on the Money
// page: the spends you actually repeat, one tap each.
//
// Deliberately NOT automatic. Writing money the user never confirmed is the exact
// failure spend-suggestion.js was built to avoid, and a wrong expense is worse
// than a missing one. Evidence is shown on the chip so the number can be judged
// before it is tapped.

import { fetchSpendPatternHistory } from "../services/supabase-data.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession } from "../services/auth.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { detectPatterns } from "../../lib/spend-patterns.mjs";
import { showToast } from "./toast.js";

const HOST_ID = "spendChips";
const MAX_CHIPS = 4;
// Below this the pattern is a guess, not a habit. Same floor the post-capture
// suggestion uses, so the two surfaces never disagree about what is learned.
const MIN_CONFIDENCE = 0.55;

let state = { chips: [], busy: false, loaded: false, error: null };

function host() {
  return document.getElementById(HOST_ID);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function renderSpendChips() {
  const el = host();
  if (!el) return;

  if (state.error) {
    // A failed history read is not "you have no habits yet" - say which it is.
    el.hidden = false;
    el.innerHTML = `<p class="chips-error">Couldn't read your spend history: ${esc(state.error)}</p>`;
    return;
  }
  if (!state.loaded || !state.chips.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }

  el.hidden = false;
  el.innerHTML = `
    <p class="chips-label">Spent this again?</p>
    <div class="chip-row" role="group" aria-label="Log a spend you make regularly">
      ${state.chips.map((c, i) => `
        <button type="button" class="meal-chip spend-chip" data-idx="${i}"
                title="${esc(c.label)} - ${esc(c.evidence || "")}"
                aria-label="Log ${esc(c.label)} for ${Math.round(c.amount)} rupees">
          <span class="meal-chip-name">Rs ${Math.round(c.amount)} · ${esc(c.label)}</span>
          <span class="meal-chip-macros">${c.observations}x${c.typicalTime ? ` · usually ${esc(c.typicalTime)}` : ""}</span>
        </button>`).join("")}
    </div>
    <p class="chips-foot">Tap to log it now at today's date. Nothing is written until you tap.</p>
  `;
}

export async function refreshSpendChips() {
  const el = host();
  if (!el) return;
  try {
    const history = await fetchSpendPatternHistory({ sinceDays: 120 });
    state.chips = detectPatterns(history.rows)
      .filter((p) => Number(p.confidence) >= MIN_CONFIDENCE && Number(p.amount) > 0)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_CHIPS);
    state.error = null;
    state.loaded = true;
  } catch (err) {
    const msg = err?.message || String(err);
    state.error = msg === "not_authenticated" ? null : msg;
    state.chips = [];
    state.loaded = true;
  }
  renderSpendChips();
}

// The row a tap writes. source_type marks it as a tapped repeat so it is never
// mistaken for something a model invented, and so re-import dedupe can see it.
async function logRepeatSpend(chip) {
  const supabase = await getSupabaseClient();
  const userId = getCurrentSession()?.user?.id;
  if (!userId) throw new Error("not signed in");
  const { error } = await supabase.from("ledger_entries").insert({
    user_id: userId,
    amount: Math.round(Number(chip.amount)),
    currency: "INR",
    direction: "expense",
    description: chip.label || "recurring spend",
    occurred_at: new Date().toISOString(),
    is_discretionary: true,
    confidence: Number(chip.confidence) || 0.7,
    source_type: "repeat_tap",
  });
  if (error) throw error;
}

export function bindSpendChips() {
  const el = host();
  if (!el) return;

  el.addEventListener("click", async (event) => {
    const btn = event.target.closest("button.spend-chip");
    if (!btn || state.busy) return;
    const chip = state.chips[Number(btn.dataset.idx)];
    if (!chip) return;

    state.busy = true;
    btn.disabled = true;
    try {
      await logRepeatSpend(chip);
      showToast(`Logged Rs ${Math.round(chip.amount)} - ${chip.label}.`);
      await hydrateStateFromSupabase();
      await refreshSpendChips();
    } catch (err) {
      showToast(`Didn't log it: ${err?.message || err}`, { kind: "error", duration: 5000 });
    } finally {
      state.busy = false;
      btn.disabled = false;
    }
  });

  refreshSpendChips();
}
