import {
  fetchLedger, fetchFoodLogs, fetchOpenAiActions, fetchOpenImports, fetchBudgets,
  fetchBodyMetrics, fetchWellnessLogs, fetchSubscriptions, persistDetectedSubscriptions,
  fetchMealTemplates, fetchUserPlans, fetchWorkoutLogs,
  fetchNotes, fetchMemoryFacts, fetchTargetEvents,
} from "../services/supabase-data.js";
import { setDietPlanOverride, setGymPlanOverride, setDatedPlanOverrides, parsePlanScope, planForDate, isoWeekday } from "../domain/diet/plan.js";
import { isPlanDelta } from "../../lib/plan-merge.mjs";
import { resolveDietTargets, goalDef } from "../domain/goals.js";
import { getBudgetPace } from "../analytics/budget-trajectory.js";
import { estimateNutrition } from "../../lib/food-nutrition.mjs";
import { isLocalSession } from "../services/auth.js";
import { updateState } from "./app-state.js";
import { detectSubscriptions } from "../domain/money/subscription-detector.js";
import { buildInsightFeed } from "../analytics/insights-engine.js";
import { buildAdditions } from "../../lib/additions.mjs";

const INR = new Intl.NumberFormat("en-IN");

function fmtAmount(amount, currency = "INR") {
  if (currency === "INR") return `Rs ${INR.format(Number(amount))}`;
  return `${currency} ${INR.format(Number(amount))}`;
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

export async function hydrateStateFromSupabase() {
  if (isLocalSession()) return;
  // A failed read is NOT an empty table. Every fetch below used to be
  // .catch(() => []), so a dropped connection rebuilt the whole dashboard from
  // empty arrays and the UI confidently said "nothing logged yet" over data that
  // was sitting right there. Track which reads failed so the UI can say
  // "couldn't load" instead of inventing an empty day.
  const failed = [];
  const soft = (name, promise) => promise.catch((err) => {
    failed.push(`${name}: ${err?.message || err}`);
    return [];
  });

  try {
    const [ledger, foods, actions, imports, budgets, bodyMetrics, wellnessLogs, knownSubs] = await Promise.all([
      soft("ledger", fetchLedger({ limit: 500 })),
      soft("food", fetchFoodLogs({ limit: 300 })),
      soft("review queue", fetchOpenAiActions()),
      soft("imports", fetchOpenImports()),
      soft("budgets", fetchBudgets()),
      soft("body metrics", fetchBodyMetrics()),
      soft("wellness", fetchWellnessLogs()),
      soft("subscriptions", fetchSubscriptions()),
    ]);
    const mealTemplates = await soft("meal templates", fetchMealTemplates());
    const userPlans = await soft("plans", fetchUserPlans());
    const workoutLogs = await soft("workouts", fetchWorkoutLogs());
    const notes = await soft("notes", fetchNotes());
    const memoryFacts = await soft("memory", fetchMemoryFacts());
    const targetEvents = await soft("target events", fetchTargetEvents());

    // Self-heal food macros at DISPLAY time: the lookup table is the source of
    // truth for everyday foods, so recompute macros from the description even for
    // rows logged before the lookup shipped (fixes stale "coffee+cookies = 10g").
    for (const f of foods) {
      const est = estimateNutrition(f.description || f.meal_name || "");
      if (est.recognized) {
        f.calories_estimate = est.totals.calories;
        f.protein_g = est.totals.protein_g;
        f.carbs_g = est.totals.carbs_g;
        f.fat_g = est.totals.fat_g;
      }
    }
    // Apply plan overrides from user_plans. A "permanent" diet plan replaces the
    // standing hub plan; a date-scoped plan (comma-separated dates, e.g. "next 4
    // Mondays") rewrites exactly those days for diet OR gym. userPlans is newest-
    // first, so the first match for a date/permanent wins.
    // Each date collects an ARRAY of rows so a one-shot delta ("add a salad bowl")
    // can fold onto an earlier full plan (or the standing scaffold). Permanent
    // deltas are ignored — permanent changes must be full replacements.
    let permanentDiet = null;
    let permanentGym = null;
    const datedDiet = new Map();
    const datedGym = new Map();
    for (const p of userPlans) {
      if (p.active === false) continue;
      const { kind: scopeKind, dates } = parsePlanScope(p.scope);
      if (scopeKind === "permanent") {
        if (p.kind === "diet" && !permanentDiet && !isPlanDelta(p.payload)) permanentDiet = p.payload;
        else if (p.kind === "gym" && !permanentGym && !isPlanDelta(p.payload)) permanentGym = p.payload;
      } else if (scopeKind === "dates") {
        const target = p.kind === "gym" ? datedGym : datedDiet;
        for (const d of dates) { if (!target.has(d)) target.set(d, []); target.get(d).push(p.payload); }
      }
    }
    // userPlans is newest-first; fold oldest->newest so a later delta stacks on an
    // earlier full replace for the same date.
    for (const m of [datedDiet, datedGym]) for (const [k, v] of m) m.set(k, v.slice().reverse());
    setDietPlanOverride(permanentDiet);
    setGymPlanOverride(permanentGym);
    setDatedPlanOverrides({ diet: datedDiet, gym: datedGym });

    // Detect subscriptions from the ledger and persist them (best-effort), then
    // use the freshest view for insights + dashboards.
    const detectedSubs = detectSubscriptions(ledger);
    if (detectedSubs.length) {
      await persistDetectedSubscriptions(detectedSubs).catch(() => {});
    }
    const subscriptions = detectedSubs.length ? detectedSubs : knownSubs;

    // Single source of truth for diet targets: budget goals override the
    // scaffold-derived plan targets. Used for insights AND the glance metrics.
    const dietTargets = resolveDietTargets(budgets, planForDate(new Date()).macroTargets);

    // Run every detector into one ranked insight feed (strings for the list UI).
    const feed = buildInsightFeed({
      ledger, foodLogs: foods, wellnessLogs, bodyMetrics, budgets, subscriptions,
      today: new Date(), proteinTargetG: dietTargets.protein_g,
    });

    const ledgerRows = ledger.map((row) => ({
      id: row.id,
      date: shortDate(row.occurred_at),
      merchant: row.merchant || "—",
      category: row.is_discretionary ? "Discretionary" : "Essential",
      amount: fmtAmount(row.amount, row.currency),
      evidence: row.direction,
      state: row.duplicate_state === "unique" ? "AI applied" : row.duplicate_state,
    }));

    const macroRows = foods.map((row) => ({
      id: row.id,
      meal: row.meal_slot || row.meal_name || "Meal",
      calories: String(row.calories_estimate ?? "—"),
      protein: row.protein_g != null ? `${row.protein_g}g` : "—",
      confidence: row.confidence > 0.8 ? "high" : row.confidence > 0.5 ? "medium" : "review",
      note: row.description?.slice(0, 90) || "",
    }));

    const reviewRows = actions.map((row) => ({
      id: row.id,
      item: humanizeTool(row.tool_name, row.arguments),
      domain: domainForTool(row.tool_name),
      confidence: `${Math.round(Number(row.confidence) * 100)}%`,
      risk: row.confidence > 0.85 ? "none" : "review",
      action: "approve / reject",
    }));

    const importRows = imports.map((row) => ({
      id: row.id,
      file: row.source_name || row.detected_bank || "Import",
      rows: String(row.row_count ?? 0),
      mapped: row.status === "mapped" ? "done" : "pending",
      duplicate: "—",
      status: row.status,
    }));

    // Trajectory columns (spent/pace/forecast/next) are a MONEY concept -- a
    // diet/gym goal (calories, protein, workouts) isn't a spend figure, so
    // only compute them for money-domain kinds; other kinds show "—".
    const budgetRows = budgets.map((row) => {
      const isMoneyGoal = goalDef(row.kind)?.domain === "money";
      let spent = "—", pace = "—", forecast = "—", next = "—";
      if (isMoneyGoal) {
        const win = periodWindow(row.period);
        const spentSoFar = ledger
          .filter((r) => r.direction === "expense" && win.since(r.occurred_at))
          .reduce((acc, r) => acc + Number(r.amount || 0), 0);
        const p = getBudgetPace({ spentSoFar, budget: Number(row.amount), dayOfMonth: win.dayOfMonth, daysInMonth: win.daysInMonth });
        spent = fmtAmount(spentSoFar);
        pace = p.pace > 1.1 ? "over" : p.pace < 0.9 ? "under" : "on track";
        forecast = fmtAmount(p.projected);
        next = fmtAmount(p.expected);
      }
      return {
        id: row.id,
        category: row.category_id ? "Category" : "All",
        period: row.period,
        amount: fmtAmount(row.amount),
        starts: shortDate(row.starts_on),
        status: "active",
        spent, pace, forecast, next,
      };
    });

    const todaySpend = sumTodayExpense(ledger);
    const protein = sumTodayProtein(foods);
    const caloriesToday = sumTodayCalories(foods);

    updateState((state) => {
      // Formatted rows for the tables.
      state.ledgerRows = ledgerRows;
      state.macroRows = macroRows;
      state.reviewRows = reviewRows;
      state.aiActions = actions; // raw actions (tool_name + arguments) for approve/apply
      state.importRows = importRows;
      state.budgetRows = budgetRows;
      // Raw arrays for the dashboards + insight engine.
      state.ledger = ledger;
      state.foodLogs = foods;
      state.userPlans = userPlans;
      state.notes = notes;
      state.memoryFacts = memoryFacts;
      // Unified day-over-day "additions" list for the Home feed (incl. notes +
      // undoable AI target changes).
      state.additions = buildAdditions(ledger, foods, userPlans, { notes, targetEvents, reviewActions: actions });
      state.wellnessLogs = wellnessLogs;
      state.bodyMetrics = bodyMetrics;
      state.workoutLogs = workoutLogs;
      state.budgets = budgets;
      state.subscriptions = subscriptions;
      state.mealTemplates = mealTemplates;
      // Detector-driven insight feed.
      state.insights = feed.lines;
      state.insightItems = feed.items;
      state.metrics.todaySpend = todaySpend;
      state.metrics.protein = protein;
      state.metrics.proteinTarget = dietTargets.protein_g;
      state.metrics.caloriesToday = caloriesToday;
      state.metrics.caloriesTarget = dietTargets.calories;
      state.metrics.caloriesLeft = Math.max(0, Math.round(dietTargets.calories - caloriesToday));
      state.metrics.mealsToday = foods.filter((r) => isSameLocalDay(r.occurred_at)).length;
      // Partial failure is still failure — say which parts, so an empty panel
      // is never mistaken for an empty day.
      state.syncError = failed.length
        ? `Couldn't load ${failed.length === 1 ? "one section" : `${failed.length} sections`} — ${failed[0]}`
        : null;
      state.syncFailedReads = failed;
    });
  } catch (err) {
    console.warn("hydrateStateFromSupabase failed", err);
    // Surface the failure instead of silently leaving a blank dashboard.
    updateState((state) => { state.syncError = err?.message || "Sync failed"; });
    return { ok: false, failed: [err?.message || "Sync failed"] };
  }
  // Returned rather than thrown: page boot awaits this and must keep going
  // (the briefing strip still renders on a partial sync). Callers that care —
  // e.g. the additions feed confirming a delete actually stuck — check `ok`.
  return { ok: failed.length === 0, failed };
}

function humanizeTool(name, args = {}) {
  switch (name) {
    case "create_expense_candidate":
      return `${args.merchant || "expense"} ${args.amount ? `Rs ${args.amount}` : ""}`.trim();
    case "create_food_log_candidate":
      return `${args.meal_slot || "meal"}: ${args.description?.slice(0, 50) || ""}`.trim();
    case "create_body_metric_candidate":
      return `${args.metric_type || "metric"} ${args.value || ""}`.trim();
    case "create_statement_row_candidate":
      return `statement row ${args.description?.slice(0, 50) || ""}`.trim();
    default:
      return name.replace(/_/g, " ");
  }
}

function domainForTool(name) {
  if (name.includes("expense") || name.includes("income") || name.includes("statement") || name.includes("transfer")) return "Money";
  if (name.includes("food")) return "Diet";
  if (name.includes("workout") || name.includes("body") || name.includes("wellness")) return "Wellness";
  return "AI";
}

function isSameLocalDay(iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Spend-to-date + period length for a budget's pace/forecast, matching its
// own period -- daily uses today, weekly uses the ISO week (Monday start),
// monthly uses the calendar month. getBudgetPace's dayOfMonth/daysInMonth
// params are really "day-into-period"/"days-in-period"; naming kept as-is
// since that's the pure function's real signature.
function periodWindow(period, now = new Date()) {
  if (period === "daily") {
    return { dayOfMonth: 1, daysInMonth: 1, since: (iso) => isSameLocalDay(iso, now) };
  }
  if (period === "weekly") {
    const wd = isoWeekday(now); // 1..7, Monday=1
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (wd - 1));
    return { dayOfMonth: wd, daysInMonth: 7, since: (iso) => iso && new Date(iso) >= start };
  }
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { dayOfMonth, daysInMonth, since: (iso) => iso && new Date(iso) >= start };
}

function sumTodayExpense(rows) {
  return rows
    .filter((r) => r.direction === "expense" && isSameLocalDay(r.occurred_at))
    .reduce((acc, r) => acc + Number(r.amount || 0), 0);
}

function sumTodayProtein(rows) {
  return rows
    .filter((r) => isSameLocalDay(r.occurred_at))
    .reduce((acc, r) => acc + Number(r.protein_g || 0), 0);
}

function sumTodayCalories(rows) {
  return rows
    .filter((r) => isSameLocalDay(r.occurred_at))
    .reduce((acc, r) => acc + Number(r.calories_estimate || 0), 0);
}
