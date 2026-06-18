// One-tap quick-log chips. These write directly to the DB (hydration, mood,
// meal templates) and never call Gemini — removing friction and AI cost from
// the highest-frequency micro-logs. Meal chips are hydrated from the user's
// saved meal_templates (state.mealTemplates).

import { getState, updateState } from "../state/app-state.js";
import { isLocalSession } from "../services/auth.js";
import { logHydration, logQuickWellness, logMealFromTemplate } from "../services/supabase-data.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

const STATIC_CHIPS = [
  { kind: "water", label: "💧 +250 ml", ml: 250 },
  { kind: "water", label: "💧 +500 ml", ml: 500 },
  { kind: "mood", label: "🙂 Good", mood: 8 },
  { kind: "mood", label: "😐 Okay", mood: 5 },
  { kind: "mood", label: "😞 Low", mood: 2 },
];

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function renderQuickLog(state = getState()) {
  const host = document.querySelector("#quickLog");
  if (!host) return;
  const templates = (state.mealTemplates || []).slice(0, 4);
  const staticChips = STATIC_CHIPS
    .map((c, i) => `<button class="quick-log-chip" type="button" data-ql="${c.kind}" data-i="${i}">${c.label}</button>`)
    .join("");
  const tplChips = templates
    .map((t, i) => `<button class="quick-log-chip" type="button" data-ql="meal" data-idx="${i}">🍽️ ${escapeHtml(t.name)}</button>`)
    .join("");
  host.innerHTML = `<span class="quick-log-label">Quick log</span>${staticChips}${tplChips}`;
}

export function bindQuickLog() {
  const host = document.querySelector("#quickLog");
  if (!host) return;
  host.addEventListener("click", async (event) => {
    const btn = event.target.closest(".quick-log-chip");
    if (!btn) return;
    btn.disabled = true;
    try {
      await handleChip(btn.dataset);
    } catch (err) {
      updateState((state) => { state.parseLog.unshift(`Quick log failed: ${err?.message || err}`); });
    } finally {
      btn.disabled = false;
    }
  });
}

async function handleChip(dataset) {
  if (isLocalSession()) {
    updateState((state) => { state.parseLog.unshift("Quick log needs a signed-in account (not local demo)."); });
    return;
  }
  const kind = dataset.ql;
  if (kind === "water") {
    const chip = STATIC_CHIPS[Number(dataset.i)];
    await logHydration(chip.ml);
    updateState((state) => { state.parseLog.unshift(`Logged ${chip.ml} ml water.`); });
  } else if (kind === "mood") {
    const chip = STATIC_CHIPS[Number(dataset.i)];
    await logQuickWellness({ mood_score: chip.mood, note: `Mood ${chip.mood}/10 (quick log)` });
    updateState((state) => { state.parseLog.unshift(`Logged mood ${chip.mood}/10.`); });
  } else if (kind === "meal") {
    const tpl = (getState().mealTemplates || [])[Number(dataset.idx)];
    if (!tpl) return;
    await logMealFromTemplate(tpl);
    updateState((state) => { state.parseLog.unshift(`Logged meal: ${tpl.name}.`); });
  }
  await hydrateStateFromSupabase().catch(() => {});
}
