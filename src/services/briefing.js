// Proactive briefings orchestrator (client-side, no cron). On Home load we pick
// the slot from the local hour, and if today's briefing for that slot doesn't
// exist yet we build it from current app state + the day's plan and upsert it
// into the `briefings` table (RLS-safe) so it persists and isn't regenerated on
// every open. The pure text composition lives in src/analytics/briefing.js.

import { planForDate, localDateKey } from "../domain/diet/plan.js";
import { buildBriefing } from "../analytics/briefing.js";
import { fetchBriefingFor, upsertBriefing, markBriefingSeen } from "./supabase-data.js";

export function briefingSlot(now = new Date()) {
  return now.getHours() < 12 ? "morning" : "evening";
}

function sameLocalDay(iso, now) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Build the snapshot buildBriefing() consumes from the hydrated app state.
export function snapshotFromState(state = {}, now = new Date()) {
  const plan = planForDate(now);
  const m = state.metrics || {};
  const budgets = state.budgets || [];
  const monthly = budgets.find((b) => b.kind === "monthly_spend")?.amount;
  const weekly = budgets.find((b) => b.kind === "weekly_spend")?.amount;
  const dailySpendCap = monthly != null ? Math.round(Number(monthly) / 30)
    : (weekly != null ? Math.round(Number(weekly) / 7) : null);
  const workoutLoggedToday = (state.workoutLogs || []).some((w) => sameLocalDay(w.occurred_at, now));
  const plannedMeals = plan.meals?.length || 0;
  const mealsLoggedToday = m.mealsToday || 0;
  return {
    forDate: localDateKey(now),
    weekdayName: plan.weekdayName,
    dietLabel: plan.dietLabel,
    workoutName: plan.workout?.name,
    workoutKind: plan.workout?.kind,
    proteinToday: m.protein,
    proteinTarget: m.proteinTarget,
    caloriesToday: m.caloriesToday,
    caloriesTarget: m.caloriesTarget,
    todaySpend: m.todaySpend,
    dailySpendCap,
    workoutLoggedToday,
    planItemsLeft: Math.max(0, plannedMeals - mealsLoggedToday),
    mealsLoggedToday,
  };
}

// Return today's briefing for the current slot, generating + persisting it once.
// Best-effort: returns null if Supabase is unavailable (offline) so the caller
// can simply render nothing.
export async function ensureTodayBriefing(state, now = new Date()) {
  try {
    const slot = briefingSlot(now);
    const forDate = localDateKey(now);
    const existing = await fetchBriefingFor({ kind: slot, forDate });
    if (existing) return existing;
    const brief = buildBriefing(slot, snapshotFromState(state, now));
    const saved = await upsertBriefing({ kind: slot, for_date: forDate, body: brief.body, payload: brief.payload });
    return saved || brief;
  } catch {
    return null;
  }
}

export { markBriefingSeen };
