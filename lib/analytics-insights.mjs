// Cross-domain personal-insight engine (PURE, browser/Node isomorphic).
//
// Turns raw ledger + foodLogs + workoutLogs + bodyMetrics + sleepSessions +
// budgets into RANKED, evidence-bearing insights. Every insight cites the rows
// it was derived from. THE UNBREAKABLE RULE holds here: an insight is NEVER
// emitted unless real rows support it. When a domain has no data we either skip
// it or emit an explicit "log a few days to see this" prompt - never a fabricated
// number, never a measured 0 for something that was never recorded.
//
// Timezone is Asia/Kolkata (day boundaries via the shared jarvis tz helpers).
//
// Each insight: { id, domain, severity, headline, detail, evidence, metric }
//   severity: 'good' | 'info' | 'warn' | 'critical'
//   metric:   structured numbers behind the claim (for tests / drill-down)
//   evidence: short human string naming the support ("5 days logged this week")

import { jbDateKeyInTz, jbAddDays } from "./jarvis-brief.mjs";

const TZ = "Asia/Kolkata";

const SEVERITY_WEIGHT = { critical: 3, warn: 2, good: 1, info: 0 };

function rupees(n) {
  return "Rs " + Math.round(Number(n) || 0).toLocaleString("en-IN");
}
function round(n) {
  return Math.round(Number(n) || 0);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Civil IST day key for a timestamp, or null if unparseable.
function dayKey(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return jbDateKeyInTz(d, TZ);
}

// Set of the last `n` civil IST day keys ending at `todayKey` (inclusive).
function lastNDayKeys(todayKey, n) {
  const keys = new Set();
  for (let i = 0; i < n; i++) keys.add(jbAddDays(todayKey, -i));
  return keys;
}

// ---- Diet: protein vs target ------------------------------------------------
function proteinInsight({ foodLogs, target, weekKeys }) {
  const inWeek = foodLogs.filter((m) => weekKeys.has(dayKey(m.occurred_at)));
  if (!inWeek.length) {
    return {
      id: "protein-nodata", domain: "diet", severity: "info",
      headline: "Protein: no meals logged this week",
      detail: "Log a few days of food and this will track your daily protein against your target.",
      evidence: "0 meals in the last 7 days",
      metric: { loggedDays: 0, target },
    };
  }
  // Average over days that actually have a log - averaging over unlogged days
  // would understate a real intake we simply did not capture.
  const byDay = new Map();
  let best = null;
  for (const m of inWeek) {
    const k = dayKey(m.occurred_at);
    const p = num(m.protein_g) || 0;
    byDay.set(k, (byDay.get(k) || 0) + p);
    if (p > 0 && (!best || p > best.protein_g)) best = { name: m.meal_name || m.description || "a meal", protein_g: p };
  }
  const loggedDays = byDay.size;
  const totalProtein = [...byDay.values()].reduce((a, b) => a + b, 0);
  const avg = totalProtein / loggedDays;
  if (target == null) {
    return {
      id: "protein-avg", domain: "diet", severity: "info",
      headline: `Protein: averaging ${round(avg)}g/day this week`,
      detail: "Set a daily protein goal to see how this compares.",
      evidence: `${loggedDays} day${loggedDays === 1 ? "" : "s"} logged this week`,
      metric: { avg: round(avg), target: null, loggedDays },
    };
  }
  const deficit = target - avg;
  const bestNote = best ? ` Your best source: ${best.name} at ${round(best.protein_g)}g.` : "";
  if (deficit > 15) {
    return {
      id: "protein-short", domain: "diet", severity: deficit > 60 ? "warn" : "info",
      headline: `Protein: averaging ${round(avg)}g/day vs your ${round(target)}g target`,
      detail: `Short by ~${round(deficit)}g every day.${bestNote}`,
      evidence: `${loggedDays} day${loggedDays === 1 ? "" : "s"} logged this week`,
      metric: { avg: round(avg), target: round(target), deficit: round(deficit), loggedDays },
    };
  }
  return {
    id: "protein-ontrack", domain: "diet", severity: "good",
    headline: `Protein: averaging ${round(avg)}g/day - on target`,
    detail: `Within ${round(Math.abs(deficit))}g of your ${round(target)}g goal.${bestNote}`,
    evidence: `${loggedDays} day${loggedDays === 1 ? "" : "s"} logged this week`,
    metric: { avg: round(avg), target: round(target), deficit: round(deficit), loggedDays },
  };
}

// ---- Diet: calories vs target ----------------------------------------------
function calorieInsight({ foodLogs, target, weekKeys }) {
  if (target == null) return null;
  const inWeek = foodLogs.filter((m) => weekKeys.has(dayKey(m.occurred_at)) && num(m.calories_estimate) != null);
  if (!inWeek.length) return null;
  const byDay = new Map();
  for (const m of inWeek) {
    const k = dayKey(m.occurred_at);
    byDay.set(k, (byDay.get(k) || 0) + (num(m.calories_estimate) || 0));
  }
  const loggedDays = byDay.size;
  const avg = [...byDay.values()].reduce((a, b) => a + b, 0) / loggedDays;
  const diff = avg - target;
  const overShort = diff >= 0 ? "over" : "under";
  const sev = Math.abs(diff) > target * 0.25 ? "warn" : "info";
  return {
    id: "calories-avg", domain: "diet", severity: Math.abs(diff) < target * 0.1 ? "good" : sev,
    headline: `Calories: averaging ${round(avg)}/day vs your ${round(target)} target`,
    detail: `~${round(Math.abs(diff))} kcal ${overShort} on the days you logged.`,
    evidence: `${loggedDays} day${loggedDays === 1 ? "" : "s"} logged this week`,
    metric: { avg: round(avg), target: round(target), diff: round(diff), loggedDays },
  };
}

// ---- Diet: meal-slot logging gap -------------------------------------------
// If breakfast is logged on most days but dinner rarely, evening calories are
// probably undercounted. Only fires with enough logged days to be meaningful.
function mealGapInsight({ foodLogs, windowKeys, windowDays }) {
  const inWindow = foodLogs.filter((m) => windowKeys.has(dayKey(m.occurred_at)));
  const loggedDays = new Set(inWindow.map((m) => dayKey(m.occurred_at)));
  if (loggedDays.size < 5) return null;
  const slotDays = { breakfast: new Set(), lunch: new Set(), dinner: new Set(), snack: new Set(), other: new Set() };
  for (const m of inWindow) {
    const slot = slotDays[m.meal_slot] ? m.meal_slot : "other";
    slotDays[slot].add(dayKey(m.occurred_at));
  }
  const denom = loggedDays.size;
  const breakfastCov = slotDays.breakfast.size / denom;
  const dinnerCov = slotDays.dinner.size / denom;
  if (breakfastCov >= 0.6 && dinnerCov < 0.5 && breakfastCov - dinnerCov >= 0.3) {
    return {
      id: "meal-gap-dinner", domain: "diet", severity: "warn",
      headline: `You log breakfast most days but dinner only ${Math.round(dinnerCov * 100)}% of them`,
      detail: "Evening calories and protein are probably undercounted - your daily totals read low because dinner is missing, not because you didn't eat.",
      evidence: `${slotDays.breakfast.size}/${denom} days breakfast, ${slotDays.dinner.size}/${denom} dinner (last ${windowDays} days)`,
      metric: { breakfastDays: slotDays.breakfast.size, dinnerDays: slotDays.dinner.size, loggedDays: denom },
    };
  }
  return null;
}

// ---- Gym: sessions done vs plan --------------------------------------------
function gymInsight({ workoutLogs, plannedPerWeek, weekKeys, twoWeekKeys }) {
  const doneWeek = new Set();
  const doneTwoWeek = new Set();
  let anyInWindow = false;
  for (const w of workoutLogs) {
    const k = dayKey(w.occurred_at);
    if (!k) continue;
    if (twoWeekKeys.has(k)) anyInWindow = true;
    if (w.status !== "done") continue;
    if (weekKeys.has(k)) doneWeek.add(k);
    if (twoWeekKeys.has(k)) doneTwoWeek.add(k);
  }
  if (!anyInWindow) return null; // no workout rows at all -> do not fabricate
  const planned = plannedPerWeek || null;
  const wk = doneWeek.size;
  const headline = planned
    ? `Gym: ${wk} of ${planned} planned days this week`
    : `Gym: ${wk} session${wk === 1 ? "" : "s"} this week`;
  let severity = "info";
  if (planned) {
    if (wk >= planned) severity = "good";
    else if (wk <= Math.floor(planned / 2)) severity = "warn";
  }
  return {
    id: "gym-frequency", domain: "gym", severity,
    headline,
    detail: `${doneTwoWeek.size} training day${doneTwoWeek.size === 1 ? "" : "s"} in the last 14.`,
    evidence: `distinct days with status='done' in workout_logs`,
    metric: { thisWeek: wk, lastTwoWeeks: doneTwoWeek.size, planned },
  };
}

// ---- Money: biggest recurring spend this week ------------------------------
function recurringSpendInsight({ ledger, weekKeys }) {
  const expenses = ledger.filter(
    (r) => r.direction === "expense" && !r.merged_into && weekKeys.has(dayKey(r.occurred_at)),
  );
  if (!expenses.length) return null;
  // Group by (merchant-or-description, rounded amount) - a repeated identical
  // charge is what "recurring" means here.
  const groups = new Map();
  for (const r of expenses) {
    const label = (r.merchant || r.description || "").trim();
    const amt = Math.abs(num(r.amount) || 0);
    if (!label || amt <= 0) continue;
    const key = label.toLowerCase() + "|" + Math.round(amt);
    const g = groups.get(key) || { label, amount: Math.round(amt), count: 0, total: 0 };
    g.count += 1;
    g.total += amt;
    groups.set(key, g);
  }
  const recurring = [...groups.values()].filter((g) => g.count >= 3);
  if (!recurring.length) return null;
  recurring.sort((a, b) => b.total - a.total);
  const top = recurring[0];
  const isBiggest = recurring.length === 1 || top.total >= recurring[1].total;
  return {
    id: "recurring-spend", domain: "money", severity: "info",
    headline: `${top.label} ${rupees(top.amount)} logged ${top.count} times this week = ${rupees(top.total)}`,
    detail: isBiggest ? "Your biggest recurring spend right now." : "A frequent recurring charge this week.",
    evidence: `${top.count} matching expense rows this week`,
    metric: { label: top.label, unit: top.amount, count: top.count, total: Math.round(top.total) },
  };
}

// ---- Money: monthly spend pace vs cap --------------------------------------
function monthPaceInsight({ ledger, monthlyCap, today, todayKey }) {
  if (monthlyCap == null) return null;
  const y = Number(todayKey.slice(0, 4));
  const m = Number(todayKey.slice(5, 7));
  const dayOfMonth = Number(todayKey.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthPrefix = todayKey.slice(0, 7); // YYYY-MM
  let spent = 0;
  let rows = 0;
  for (const r of ledger) {
    if (r.direction !== "expense" || r.merged_into) continue;
    const k = dayKey(r.occurred_at);
    if (!k || k.slice(0, 7) !== monthPrefix) continue;
    spent += Math.abs(num(r.amount) || 0);
    rows += 1;
  }
  if (!rows) return null;
  const perDay = spent / dayOfMonth;
  const projected = perDay * daysInMonth;
  const overCap = projected > monthlyCap;
  const severity = overCap ? (projected > monthlyCap * 1.15 ? "critical" : "warn") : "good";
  const tail = overCap
    ? `at this pace ~${rupees(projected)} by month end - over your ${rupees(monthlyCap)} cap.`
    : `at this pace ~${rupees(projected)} by month end, within your ${rupees(monthlyCap)} cap.`;
  return {
    id: "month-pace", domain: "money", severity,
    headline: `Spend is ${rupees(spent)} this month, ~${rupees(perDay)}/day`,
    detail: tail,
    evidence: `${rows} expense rows, day ${dayOfMonth} of ${daysInMonth}`,
    metric: { spent: round(spent), perDay: round(perDay), projected: round(projected), cap: round(monthlyCap) },
  };
}

// ---- Body: weight trend ----------------------------------------------------
function weightInsight({ bodyMetrics, monthKeys }) {
  const pts = bodyMetrics
    .filter((b) => b.metric_type === "weight" && num(b.value) != null && monthKeys.has(dayKey(b.occurred_at)))
    .map((b) => ({ t: new Date(b.occurred_at).getTime(), v: num(b.value) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null; // one reading is not a trend - never invent one
  const first = pts[0], last = pts[pts.length - 1];
  const change = last.v - first.v;
  const days = Math.max(1, Math.round((last.t - first.t) / 86400000));
  const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const abs = Math.abs(change);
  return {
    id: "weight-trend", domain: "body", severity: "info",
    headline: dir === "flat"
      ? `Weight steady at ${last.v} kg`
      : `Weight ${dir} ${abs.toFixed(1)} kg over ${days} day${days === 1 ? "" : "s"}`,
    detail: `Now ${last.v} kg (was ${first.v} kg).`,
    evidence: `${pts.length} weight readings`,
    metric: { first: first.v, last: last.v, change: Number(change.toFixed(1)), days, readings: pts.length },
  };
}

/**
 * Build the ranked insight feed.
 * @returns {{insights: Array, empty: boolean, reason?: string}}
 */
export function buildInsights({
  ledger = [], foodLogs = [], workoutLogs = [], bodyMetrics = [],
  sleepSessions = [], budgets = [], today = new Date(),
  proteinTarget = null, calorieTarget = null,
} = {}) {
  const todayKey = jbDateKeyInTz(new Date(today), TZ);
  const weekKeys = lastNDayKeys(todayKey, 7);
  const twoWeekKeys = lastNDayKeys(todayKey, 14);
  const monthKeys = lastNDayKeys(todayKey, 45);

  const budgetAmount = (kind) => {
    const row = (budgets || []).find((b) => b.kind === kind);
    return row && row.amount != null ? Number(row.amount) : null;
  };
  const plannedWorkouts = budgetAmount("weekly_workouts");
  const monthlyCap = budgetAmount("monthly_spend");
  const pTarget = proteinTarget != null ? proteinTarget : budgetAmount("daily_protein");
  const cTarget = calorieTarget != null ? calorieTarget : budgetAmount("daily_calories");

  const hasAnyData =
    ledger.length || foodLogs.length || workoutLogs.length ||
    bodyMetrics.length || sleepSessions.length;
  if (!hasAnyData) {
    return { insights: [], empty: true, reason: "No captures yet - log money, food, or a workout and insights appear here." };
  }

  const candidates = [
    foodLogs.length ? proteinInsight({ foodLogs, target: pTarget, weekKeys }) : null,
    foodLogs.length ? calorieInsight({ foodLogs, target: cTarget, weekKeys }) : null,
    foodLogs.length ? mealGapInsight({ foodLogs, windowKeys: twoWeekKeys, windowDays: 14 }) : null,
    workoutLogs.length ? gymInsight({ workoutLogs, plannedPerWeek: plannedWorkouts, weekKeys, twoWeekKeys }) : null,
    ledger.length ? recurringSpendInsight({ ledger, weekKeys }) : null,
    ledger.length ? monthPaceInsight({ ledger, monthlyCap, today, todayKey }) : null,
    bodyMetrics.length ? weightInsight({ bodyMetrics, monthKeys }) : null,
  ].filter(Boolean);

  candidates.sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0));

  if (!candidates.length) {
    return { insights: [], empty: true, reason: "Not enough logged yet to say anything real. Keep capturing for a few days." };
  }
  return { insights: candidates, empty: false };
}

export default { buildInsights };
