// Proactive briefings orchestrator. The scheduled `jarvis` edge function
// (pg_cron → pg_net, see 20260706000015_jarvis_engine.sql) writes the real
// morning/evening briefings server-side before the app is even opened; Home
// shows the freshest server row and subscribes to Realtime so a brief landing
// mid-session appears live. The client-side generator below survives purely as
// the OFFLINE fallback. Pure text composition lives in src/analytics/briefing.js.

import { planForDate, localDateKey } from "../domain/diet/plan.js";
import { buildBriefing } from "../analytics/briefing.js";
import { fetchBriefingFor, fetchLatestBriefing, upsertBriefing, markBriefingSeen } from "./supabase-data.js";
import { getSupabaseClient } from "./supabase-client.js";

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

// Return today's briefing: the freshest server-written row wins (the jarvis fn
// runs before the user wakes up); only when nothing exists for today do we fall
// back to generating one client-side from hydrated state (offline resilience).
// Best-effort: returns null if Supabase is unavailable so the caller renders nothing.
export async function ensureTodayBriefing(state, now = new Date()) {
  try {
    const forDate = localDateKey(now);
    const latest = await fetchLatestBriefing(forDate);
    if (latest) return latest;
    const slot = briefingSlot(now);
    const brief = buildBriefing(slot, snapshotFromState(state, now));
    const saved = await upsertBriefing({ kind: slot, for_date: forDate, body: brief.body, payload: brief.payload });
    return saved || brief;
  } catch {
    return null;
  }
}

// Live arrival: re-render when the jarvis fn inserts/updates today's briefing
// while the app is open (Realtime publication added in 20260706000015).
// Returns the channel (or null when offline/signed out); caller may ignore it.
export async function watchTodayBriefings(onBriefing, now = new Date()) {
  try {
    const supabase = await getSupabaseClient();
    const { data } = await supabase.auth.getUser();
    const uid = data?.user?.id;
    if (!uid) return null;
    const forDate = localDateKey(now);
    return supabase
      .channel("jarvis-briefings")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "briefings", filter: `user_id=eq.${uid}` },
        (payload) => {
          const row = payload.new;
          if (row && row.for_date === forDate && !row.seen && (row.kind === "morning" || row.kind === "evening")) {
            onBriefing(row);
          }
        },
      )
      .subscribe();
  } catch {
    return null;
  }
}

export { markBriefingSeen };
