// The offer half of pattern learning. The server detects that a capture names a
// recurring meal but no price (e.g. the Rs 110 lunch logged four times), and
// attaches a suggestion to the response. This renders it as a tap-to-accept
// prompt with the EVIDENCE visible, never a silent write.
//
// The whole reason it is a prompt and not an assumption: the owner asked for
// "prompt me to put the amount, OR just assume" - and assuming money they never
// stated is the exact class of bug that broke their trust. So we show the
// evidence and let them decide. One tap adds it; ignoring it costs nothing.

import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession } from "../services/auth.js";
import { showToast } from "./toast.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

const HOST_ID = "spendSuggestion";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function host() {
  return document.getElementById(HOST_ID);
}

export function clearSpendSuggestion() {
  const el = host();
  if (el) { el.innerHTML = ""; el.hidden = true; }
}

// s is the server's suggestion object (see lib/spend-patterns.mjs suggestForCapture):
// { amount, currency, evidence, label, confidence, patternId, ... } plus the
// ingestionId to attach the accepted expense to. Never called with a null s.
export function renderSpendSuggestion(s, { ingestionId } = {}) {
  const el = host();
  if (!el || !s || !(Number(s.amount) > 0)) { clearSpendSuggestion(); return; }

  const amount = Math.round(Number(s.amount));
  el.hidden = false;
  el.innerHTML = `
    <div class="spend-suggest-card" role="group" aria-label="Suggested amount">
      <div class="spend-suggest-body">
        <p class="spend-suggest-lead">Add <strong>Rs ${amount}</strong> for this?</p>
        <p class="spend-suggest-evidence">${esc(s.evidence || `You usually pay Rs ${amount} for ${s.label || "this"}.`)}</p>
      </div>
      <div class="spend-suggest-actions">
        <button type="button" class="spend-suggest-add primary-button" data-amount="${amount}">Add Rs ${amount}</button>
        <button type="button" class="spend-suggest-dismiss secondary-button">Not this time</button>
      </div>
    </div>
  `;

  el.querySelector(".spend-suggest-dismiss").addEventListener("click", clearSpendSuggestion);
  el.querySelector(".spend-suggest-add").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "Adding...";
    try {
      await acceptSpendSuggestion(s, { ingestionId });
      showToast(`Added Rs ${amount}.`);
      clearSpendSuggestion();
      await hydrateStateFromSupabase();
    } catch (err) {
      // Loudly - a spend that silently failed to save is worse than no button.
      btn.disabled = false;
      btn.textContent = `Add Rs ${amount}`;
      showToast(`Couldn't add: ${err?.message || err}`, { kind: "error", duration: 5000 });
    }
  });
}

// Writes the accepted amount as a real expense the user explicitly confirmed.
// Tagged so its provenance (a suggestion the user accepted) is never mistaken
// for something the model invented.
async function acceptSpendSuggestion(s, { ingestionId } = {}) {
  const supabase = await getSupabaseClient();
  const session = getCurrentSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("not signed in");

  const { error } = await supabase.from("ledger_entries").insert({
    user_id: userId,
    ingestion_id: ingestionId || null,
    amount: Math.round(Number(s.amount)),
    currency: s.currency || "INR",
    direction: "expense",
    description: s.label || "recurring spend",
    occurred_at: new Date().toISOString(),
    is_discretionary: true,
    confidence: Number(s.confidence) || 0.7,
    source_type: "pattern_suggestion_accepted",
  });
  if (error) throw error;
}
