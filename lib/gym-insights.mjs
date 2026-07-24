// Gym intelligence - PURE (no DOM, no Supabase), browser/Node-isomorphic.
//
// Derives real training insight from workout_logs + bodyMetrics(weight) + the
// weekly_workouts goal. Every number is traced to rows that exist. When the
// evidence is thin (empty sets arrays, no bodyweight, no steps) this module
// returns an explicit "not enough data" signal rather than a fabricated value.
//
// THE UNBREAKABLE RULE lives here: a metric that was never recorded is `null`
// with a reason, never 0, never an invented trend. This owner logs workouts via
// a button (sets arrays are usually empty), so progression MUST detect the
// absence and say so instead of drawing a flat/fake line.

import { jbDateKeyInTz, jbAddDays, jbWeekdayFromKey } from "./jarvis-brief.mjs";

const TZ = "Asia/Kolkata";
const DEFAULT_WEEKLY_TARGET = 4; // matches GOALS weekly_workouts seed

// --- tiny pure helpers ------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dayKey(iso, tz = TZ) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return jbDateKeyInTz(d, tz);
}

// Monday-anchored week start key (ISO week) for a civil date key.
function weekStartKey(dateKey) {
  return jbAddDays(dateKey, -(jbWeekdayFromKey(dateKey) - 1));
}

// weekly_workouts target from the keyed budgets array; seed default if unset.
// Kept inline so lib/ stays free of a src/ import.
function weeklyTarget(budgets) {
  const row = (budgets || []).find((b) => b && b.kind === "weekly_workouts");
  const v = row && row.amount != null ? Number(row.amount) : null;
  return v != null && v > 0 ? v : DEFAULT_WEEKLY_TARGET;
}

// Distinct calendar days on which a DONE workout was logged. One gym trip logged
// twice collapses to one day - we count sessions by day, never by row.
function distinctDoneDays(logs, tz = TZ) {
  const set = new Set();
  for (const w of logs || []) {
    if (!w || w.status !== "done") continue;
    const k = dayKey(w.occurred_at, tz);
    if (k) set.add(k);
  }
  return set;
}

// --- weekly consistency -----------------------------------------------------

function computeConsistency(logs, budgets, now, tz) {
  const target = weeklyTarget(budgets);
  const todayKey = jbDateKeyInTz(now, tz);
  const thisWeekStart = weekStartKey(todayKey);
  const doneDays = distinctDoneDays(logs, tz);

  // Last ~8 ISO weeks (oldest -> newest), distinct done-days per week.
  const WEEKS = 8;
  const weeks = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const start = jbAddDays(thisWeekStart, -7 * i);
    const end = jbAddDays(start, 7); // exclusive
    let n = 0;
    for (const k of doneDays) if (k >= start && k < end) n++;
    weeks.push({
      weekStart: start,
      doneDays: n,
      isCurrent: start === thisWeekStart,
      // e.g. "Jul 21" style short label for the bar axis
      label: shortDayLabel(start),
    });
  }

  const doneThisWeek = weeks[weeks.length - 1].doneDays;

  // Last-14-day rate: distinct done days over the trailing 14 calendar days.
  const from14 = jbAddDays(todayKey, -13);
  let done14 = 0;
  for (const k of doneDays) if (k >= from14 && k <= todayKey) done14++;

  // Current streak of ACTIVE weeks (>=1 done day). Count back from the current
  // week if it is already active; otherwise from the most recent completed week,
  // so an as-yet-untrained current week does not falsely zero the streak.
  let streakWeeks = 0;
  const currentActive = doneThisWeek > 0;
  let cursor = currentActive ? 0 : 1;
  // extend the lookback beyond the 8 chart weeks so a long streak reads true
  for (let i = cursor; i < 260; i++) {
    const start = jbAddDays(thisWeekStart, -7 * i);
    const end = jbAddDays(start, 7);
    let n = 0;
    for (const k of doneDays) if (k >= start && k < end) n++;
    if (n > 0) streakWeeks++;
    else break;
  }

  return {
    hasData: doneDays.size > 0,
    target,
    doneThisWeek,
    metThisWeek: doneThisWeek >= target,
    weekStart: thisWeekStart,
    last14Days: done14,
    // fraction of target days hit per week, averaged over the trailing 2 weeks
    last14Rate: target > 0 ? Math.round((done14 / (target * 2)) * 100) : null,
    streakWeeks,
    weeks,
  };
}

function shortDayLabel(dateKey) {
  const d = new Date(dateKey + "T00:00:00Z");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${mon} ${d.getUTCDate()}`;
}

// --- progression (only if real per-set weights exist) -----------------------

function computeProgression(logs, tz) {
  // Collect every real weighted set. A "real" set has a numeric weight_kg > 0.
  const perExercise = new Map(); // key -> { name, points: [{dateKey, weight}] }
  let totalSets = 0;
  let weightedSets = 0;

  for (const w of logs || []) {
    if (!w || w.status !== "done") continue;
    const sets = Array.isArray(w.sets) ? w.sets : [];
    if (sets.length) totalSets += sets.length;
    const k = dayKey(w.occurred_at, tz);
    for (const s of sets) {
      if (!s) continue;
      const wt = num(s.weight_kg);
      if (wt == null || wt <= 0) continue;
      weightedSets++;
      const name = String(s.exercise || "").trim() || "Unnamed lift";
      const key = name.toLowerCase();
      if (!perExercise.has(key)) perExercise.set(key, { name, byDay: new Map() });
      const rec = perExercise.get(key);
      // top weight seen on that day
      const prev = rec.byDay.get(k) || 0;
      if (wt > prev) rec.byDay.set(k, wt);
    }
  }

  const hasSets = weightedSets > 0;
  if (!hasSets) {
    return {
      hasSets: false,
      exercises: [],
      totalSetsLogged: totalSets,
      message:
        "Start logging your sets/weights on the Gym page to unlock progression tracking. Right now workouts are logged as done, but without per-set weights there is nothing to trend - and this panel will not invent one.",
    };
  }

  const exercises = [];
  for (const rec of perExercise.values()) {
    const points = Array.from(rec.byDay.entries())
      .map(([dateKey, weight]) => ({ dateKey, weight }))
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
    const top = Math.max(...points.map((p) => p.weight));
    let trend = "single";
    if (points.length >= 2) {
      const first = points[0].weight;
      const last = points[points.length - 1].weight;
      if (last > first) trend = "up";
      else if (last < first) trend = "down";
      else trend = "stall";
    }
    exercises.push({ exercise: rec.name, points, top, trend, sessions: points.length });
  }
  exercises.sort((a, b) => b.sessions - a.sessions || b.top - a.top);

  return { hasSets: true, exercises, totalSetsLogged: totalSets, message: null };
}

// --- bodyweight trend -------------------------------------------------------

function computeBodyweight(bodyMetrics, tz) {
  const points = [];
  for (const m of bodyMetrics || []) {
    if (!m || m.metric_type !== "weight") continue;
    const v = num(m.value);
    const k = dayKey(m.occurred_at, tz);
    if (v == null || v <= 0 || !k) continue;
    points.push({ dateKey: k, value: v, at: m.occurred_at });
  }
  points.sort((a, b) => (a.at < b.at ? -1 : 1));

  if (points.length === 0) {
    return { hasData: false, points: [], latest: null, message: "Add a weight to see the trend." };
  }
  if (points.length === 1) {
    return {
      hasData: false,
      points,
      latest: points[0].value,
      message: "Add another weight to see the trend - one reading is a point, not a line.",
    };
  }
  const first = points[0].value;
  const latest = points[points.length - 1].value;
  const delta = Math.round((latest - first) * 10) / 10;
  return {
    hasData: true,
    points,
    latest,
    first,
    delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    message: null,
  };
}

// --- muscle-group balance (only from logged sets that name a muscle) --------

function computeMuscleBalance(logs) {
  const counts = new Map();
  for (const w of logs || []) {
    if (!w || w.status !== "done") continue;
    const sets = Array.isArray(w.sets) ? w.sets : [];
    for (const s of sets) {
      if (!s) continue;
      const muscle = String(s.muscle || "").trim();
      if (!muscle) continue;
      counts.set(muscle, (counts.get(muscle) || 0) + 1);
    }
  }
  if (counts.size === 0) {
    return {
      hasData: false,
      groups: [],
      message: "Muscle-group balance appears once your logged sets name a muscle. Nothing to split yet.",
    };
  }
  const groups = Array.from(counts.entries())
    .map(([muscle, sets]) => ({ muscle, sets }))
    .sort((a, b) => b.sets - a.sets);
  return { hasData: true, groups, message: null };
}

// --- rest / skip pattern ----------------------------------------------------

function computeRestPattern(logs, now, tz) {
  const todayKey = jbDateKeyInTz(now, tz);
  const from = jbAddDays(todayKey, -13); // trailing 14 days
  const done = new Set();
  const skipped = new Set();
  const rest = new Set();
  for (const w of logs || []) {
    if (!w) continue;
    const k = dayKey(w.occurred_at, tz);
    if (!k || k < from || k > todayKey) continue;
    if (w.status === "done") done.add(k);
    else if (w.status === "skipped") skipped.add(k);
    else if (w.status === "rest") rest.add(k);
  }
  const anyLogged = done.size + skipped.size + rest.size > 0;
  return {
    hasData: anyLogged,
    windowDays: 14,
    doneDays: done.size,
    skippedDays: skipped.size,
    restDays: rest.size,
    message: anyLogged ? null : "No workout activity logged in the last 14 days.",
  };
}

// --- public entry -----------------------------------------------------------

export function computeGymInsights({ workoutLogs = [], bodyMetrics = [], budgets = [], now = new Date(), tz = TZ } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  return {
    generatedAt: nowDate.toISOString(),
    consistency: computeConsistency(workoutLogs, budgets, nowDate, tz),
    progression: computeProgression(workoutLogs, tz),
    bodyweight: computeBodyweight(bodyMetrics, tz),
    muscleBalance: computeMuscleBalance(workoutLogs),
    restPattern: computeRestPattern(workoutLogs, nowDate, tz),
  };
}

export default { computeGymInsights };
