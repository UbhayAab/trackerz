// Proactive briefing composer. Turns a day snapshot into a morning (forward-
// looking) or evening (status + nudges) briefing. Pure (no DOM, no Supabase, no
// clock) so it's unit-tested; the service layer builds the snapshot from app
// state and persists the result into the `briefings` table.

function r(n) { return Math.round(Number(n) || 0); }

function pickStats(s) {
  return {
    proteinToday: r(s.proteinToday), proteinTarget: r(s.proteinTarget),
    caloriesToday: r(s.caloriesToday), caloriesTarget: r(s.caloriesTarget),
    todaySpend: r(s.todaySpend), workoutLoggedToday: Boolean(s.workoutLoggedToday),
  };
}

// kind: "morning" | "evening". snapshot: see src/services/briefing.js.
// Returns { kind, forDate, body, payload: { headline, nudges, stats } }.
export function buildBriefing(kind, snapshot = {}) {
  const s = snapshot;
  const forDate = s.forDate || "";

  if (kind === "morning") {
    const lines = [];
    const head = `Good morning — ${s.weekdayName || "today"}${s.dietLabel ? `, ${s.dietLabel}` : ""}.`;
    lines.push(head);
    if (s.workoutName) lines.push(`Planned: ${s.workoutName}${s.workoutKind === "cardio" ? " (forgiven cardio day)" : ""}.`);
    const targets = [];
    if (s.proteinTarget) targets.push(`${r(s.proteinTarget)}g protein`);
    if (s.caloriesTarget) targets.push(`${r(s.caloriesTarget)} kcal`);
    if (targets.length) lines.push(`Targets: ${targets.join(", ")}.`);
    if (s.dailySpendCap != null) lines.push(`Spend budget today: ~Rs ${r(s.dailySpendCap)}.`);
    return { kind, forDate, body: lines.join(" "), payload: { headline: head, nudges: lines.slice(1), stats: pickStats(s) } };
  }

  // evening — only ACTIONABLE nudges (a neutral "on track" if there are none).
  const nudges = [];
  if (s.proteinTarget) {
    const gap = r(s.proteinTarget) - r(s.proteinToday);
    if (gap > 10) nudges.push(`${gap}g protein to go`);
  }
  if (s.caloriesTarget) {
    const over = r(s.caloriesToday) - r(s.caloriesTarget);
    if (over > 50) nudges.push(`${over} kcal over target`);
  }
  if (s.workoutKind && s.workoutKind !== "rest" && !s.workoutLoggedToday) {
    nudges.push(`gym not logged yet (${s.workoutName || "workout"})`);
  }
  if (s.dailySpendCap != null && r(s.todaySpend) > r(s.dailySpendCap)) {
    nudges.push(`over today's spend by Rs ${r(s.todaySpend) - r(s.dailySpendCap)}`);
  }
  if (s.planItemsLeft != null && s.planItemsLeft > 0) {
    nudges.push(`${s.planItemsLeft} plan item${s.planItemsLeft === 1 ? "" : "s"} left`);
  }
  const headline = nudges.length ? "Evening check-in — a few things left" : "Evening check-in — on track ✓";
  const body = nudges.length ? `${headline}: ${nudges.join(" · ")}.` : `${headline}.`;
  return { kind, forDate, body, payload: { headline, nudges, stats: pickStats(s) } };
}
