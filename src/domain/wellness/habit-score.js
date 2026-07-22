// Computes a 0-100 habit score with per-component breakdown.
// Pure function - inputs are arrays of rows shaped like the supabase tables
// (wellness_logs, body_metrics, food_logs, ledger_entries). `todayISO` is an
// ISO date string anchoring the 7-day window.

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function windowDays(todayISO, days = 7) {
  const anchor = todayISO ? new Date(todayISO) : new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  const start = new Date(anchor.getTime() - (days - 1) * DAY_MS);
  return { start, end: anchor };
}

function inWindow(value, start, end) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() >= start.getTime() && d.getTime() <= end.getTime() + DAY_MS - 1;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeHabitScore({
  wellnessLogs = [],
  bodyMetrics = [],
  foodLogs = [],
  ledger = [],
  todayISO,
  proteinTargetG = 100,
  dailyBudget = 1500,
} = {}) {
  const { start, end } = windowDays(todayISO, 7);

  // --- Sleep avg
  const sleepValues = bodyMetrics
    .filter((m) => m.metric_type === "sleep_hours" && inWindow(m.occurred_at, start, end))
    .map((m) => Number(m.value || 0));
  const sleepAvg = Number(average(sleepValues).toFixed(2));
  const sleepHit = sleepAvg >= 7;

  // --- Steps avg
  const stepsByDay = new Map();
  for (const m of bodyMetrics) {
    if (m.metric_type !== "steps") continue;
    if (!inWindow(m.occurred_at, start, end)) continue;
    const key = dayKey(m.occurred_at);
    stepsByDay.set(key, (stepsByDay.get(key) || 0) + Number(m.value || 0));
  }
  const stepsAvg = stepsByDay.size ? Number(average([...stepsByDay.values()]).toFixed(0)) : 0;
  const stepsHit = stepsAvg >= 7000;

  // --- Protein target hit days
  const proteinByDay = new Map();
  for (const f of foodLogs) {
    if (!inWindow(f.occurred_at, start, end)) continue;
    const key = dayKey(f.occurred_at);
    proteinByDay.set(key, (proteinByDay.get(key) || 0) + Number(f.protein_g || 0));
  }
  const proteinHitDays = [...proteinByDay.values()].filter((v) => v >= proteinTargetG).length;
  const proteinHit = proteinHitDays >= 5;

  // --- Budget pace: total spent over window vs 7-day allowance
  const expensesInWindow = ledger
    .filter((l) => l.direction === "expense" && inWindow(l.occurred_at, start, end))
    .reduce((a, l) => a + Math.abs(Number(l.amount || 0)), 0);
  const budgetWindowCap = dailyBudget * 7;
  const budgetHit = budgetWindowCap === 0 ? true : expensesInWindow <= budgetWindowCap;

  // --- Mood stable: no day with mood < 4
  const moodsByDay = new Map();
  for (const w of wellnessLogs) {
    if (!inWindow(w.occurred_at, start, end)) continue;
    if (w.mood_score == null) continue;
    const key = dayKey(w.occurred_at);
    const prev = moodsByDay.get(key);
    if (prev == null || w.mood_score < prev) moodsByDay.set(key, Number(w.mood_score));
  }
  const lowMoodDay = [...moodsByDay.values()].some((v) => v < 4);
  const moodHit = !lowMoodDay;

  // --- Workouts: count distinct days with a wellness_logs note mentioning workout/gym/run/yoga,
  //     or any body_metrics steps day >= 9000 (heuristic). Need 3+ days.
  const workoutDays = new Set();
  for (const w of wellnessLogs) {
    if (!inWindow(w.occurred_at, start, end)) continue;
    const text = String(w.note || "").toLowerCase();
    if (/(workout|gym|run|jog|yoga|hiit|lift|swim|cycle|cycling|cardio)/.test(text)) {
      workoutDays.add(dayKey(w.occurred_at));
    }
  }
  for (const [day, count] of stepsByDay.entries()) {
    if (count >= 9000) workoutDays.add(day);
  }
  const workoutHit = workoutDays.size >= 3;

  const components = [
    {
      name: "sleep",
      weight: 25,
      hit: sleepHit,
      value: sleepAvg,
      note: `7d avg sleep ${sleepAvg}h (target ≥7h)`,
    },
    {
      name: "steps",
      weight: 20,
      hit: stepsHit,
      value: stepsAvg,
      note: `7d avg steps ${stepsAvg} (target ≥7000)`,
    },
    {
      name: "protein",
      weight: 15,
      hit: proteinHit,
      value: proteinHitDays,
      note: `${proteinHitDays}/7 days hit ${proteinTargetG}g protein target`,
    },
    {
      name: "budget",
      weight: 15,
      hit: budgetHit,
      value: Number(expensesInWindow.toFixed(2)),
      note: `Spent ₹${expensesInWindow.toFixed(0)} of ₹${budgetWindowCap} 7-day pace`,
    },
    {
      name: "mood",
      weight: 10,
      hit: moodHit,
      value: moodsByDay.size,
      note: lowMoodDay ? "Had a low-mood day (<4)" : "No low-mood days",
    },
    {
      name: "workout",
      weight: 15,
      hit: workoutHit,
      value: workoutDays.size,
      note: `${workoutDays.size} workout day(s) (target ≥3)`,
    },
  ];

  const score = components.reduce((acc, c) => acc + (c.hit ? c.weight : 0), 0);
  return { score, components };
}
