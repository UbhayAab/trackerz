// REQUEST ROUTER: the most important fork in the capture pipeline. A capture is
// either a LOG ("something happened" → write a ledger/food/workout row) or a
// COMMAND that must CHANGE the scaffolding itself:
//   - plan_change  → update the diet/gym PLAN (update_plan_candidate), NOT a log,
//                    and NEVER tick a checklist. "change my gym today", "next 4
//                    Mondays I'll have paneer salad", "here's my new schedule".
//   - budget_change→ change a budget/target (set_target_candidate), NOT a ₹0
//                    expense. "raise my protein goal", "set my spend cap to 40k".
//   - query        → a question, not an event. "how much did I spend?".
//   - log          → the default: a real event to record.
// Pure (no DOM/Supabase) so it's tested; the edge function keeps an inline mirror.

function lc(text) {
  return String(text || "").toLowerCase();
}

// Phrases use includes (multi-word); bare tokens use a word boundary.
function hasAny(t, words) {
  return words.some((w) => (/[^a-z0-9]/.test(w) ? t.includes(w) : new RegExp(`\\b${w}\\b`).test(t)));
}

// Changing the standing diet/gym PLAN or SCHEDULE (permanent or date-scoped).
export const PLAN_CHANGE_CUES = [
  "change my plan", "update my plan", "change my schedule", "update my schedule",
  "change the schedule", "change the plan", "edit my plan", "modify my plan",
  "adjust my plan", "adjust my schedule", "set my plan", "my new plan", "my new diet",
  "new schedule", "new plan", "new routine", "new split", "here is my schedule",
  "here's my schedule", "here is my new", "here's my new", "here is my latest",
  "here's my latest", "latest schedule", "latest plan", "dump of my", "switch my plan",
  "switch my diet", "change my diet", "update my diet", "change my workout",
  "update my workout", "change my gym", "update my gym", "change my routine",
  "from now on", "going forward", "starting today", "starting tomorrow", "starting monday",
  "for the next", "rest day", "make it a rest", "replace", "swap out", "swap my",
  "won't do", "wont do", "no longer do", "stop doing", "not do the schedule",
  "instead of", "reschedule", "rework my", "redo my plan", "i'll be having",
  "i will be having", "i'll have", "i will have",
];

// Changing a budget / target / goal / cap (money or diet).
export const BUDGET_CHANGE_CUES = [
  "change my budget", "adjust my budget", "set my budget", "update my budget",
  "increase my budget", "decrease my budget", "raise my budget", "lower my budget",
  "set my target", "change my target", "adjust my target", "raise my target",
  "lower my target", "set my goal", "change my goal", "raise my goal", "lower my goal",
  "calorie budget", "calorie target", "calorie goal", "protein target", "protein goal",
  "protein budget", "spend cap", "spending cap", "food cap", "food budget",
  "money budget", "monthly budget", "weekly budget", "daily budget", "budget cap",
  "set my calorie", "set my protein", "set my spend", "change my cap", "adjust my cap",
  "raise my cap", "lower my cap", "budget to", "target to", "cap it at", "cap to",
  "goal to", "make my budget", "make my target", "increase my cap", "decrease my cap",
];

// Asking a question, not recording an event.
export const QUERY_CUES = [
  "how much", "how many", "what did i", "what have i", "what's my", "whats my",
  "what is my", "show me", "how am i doing", "am i on track", "how's my", "hows my",
  "when did i", "why did i", "summary of", "give me a report", "how far", "how close",
  "do i have", "can i afford", "what's left", "whats left", "how's it going",
];

// Cues that a CHANGE message ALSO carries a real logged event, so the brain should
// still be allowed to log it (a mixed "change X, also I ate Y" capture).
const LOG_OVERRIDE_CUES = [
  "also i ate", "also had", "also did", "i ate", "i just ate", "just had", "i had",
  "and i ate", "and had", "today i did", "also spent", "also paid",
];

// Returns 'plan_change' | 'budget_change' | 'query' | 'log'. budget beats plan
// (more specific), plan beats query, query beats log. A bare event -> 'log'.
export function classifyRequestKind(text = "") {
  const t = lc(text);
  if (!t.trim()) return "log";
  if (hasAny(t, BUDGET_CHANGE_CUES)) return "budget_change";
  if (hasAny(t, PLAN_CHANGE_CUES)) return "plan_change";
  if (hasAny(t, QUERY_CUES)) return "query";
  return "log";
}

// True when the capture is a command/question, NOT a loggable event — the
// deterministic log-salvage must be SUPPRESSED so we never tick a checklist or
// write a ledger/food/workout row for "change my plan" / "raise my budget".
export function isChangeRequest(text = "") {
  return classifyRequestKind(text) !== "log";
}

// A change message that ALSO clearly logs something ("change my plan; also I ate
// dal") — the brain is allowed to emit a log here; only the deterministic salvage
// stays suppressed.
export function carriesLoggedEvent(text = "") {
  return hasAny(lc(text), LOG_OVERRIDE_CUES);
}
