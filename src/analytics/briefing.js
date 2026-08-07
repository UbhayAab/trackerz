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

/**
 * "Targets" when he chose them, "Defaults" when the app did.
 *
 * `targetSources` is `{calories, protein_g}` with values "user" or "default".
 * When it is ABSENT the source is genuinely unknown, and an unknown source must
 * not be reported as either one - so the neutral "Targets" is used and no claim
 * of authorship is made. Only an explicit all-default answer earns the label
 * that says so.
 */
export function targetsLabel(s = {}) {
  const src = s.targetSources;
  if (!src) return "Targets";
  const used = [];
  if (s.proteinTarget) used.push(src.protein_g);
  if (s.caloriesTarget) used.push(src.calories);
  if (!used.length) return "Targets";
  if (used.every((v) => v === "default")) return "Targets (app defaults, not set by you)";
  if (used.every((v) => v === "user")) return "Targets";
  return "Targets (partly app defaults)";
}

// kind: "morning" | "evening". snapshot: see src/services/briefing.js.
// Returns { kind, forDate, body, payload: { headline, nudges, stats } }.
export function buildBriefing(kind, snapshot = {}) {
  const s = snapshot;
  const forDate = s.forDate || "";

  if (kind === "morning") {
    const lines = [];
    const head = `Good morning - ${s.weekdayName || "today"}${s.dietLabel ? `, ${s.dietLabel}` : ""}.`;
    lines.push(head);
    if (s.workoutName) lines.push(`Planned: ${s.workoutName}${s.workoutKind === "cardio" ? " (forgiven cardio day)" : ""}.`);
    const targets = [];
    if (s.proteinTarget) targets.push(`${r(s.proteinTarget)}g protein`);
    if (s.caloriesTarget) targets.push(`${r(s.caloriesTarget)} kcal`);
    // A default is not a goal. `budgets` has been empty for the life of this
    // app, so every "Targets: 162g protein" ever printed was the scaffold value
    // read back to him as his own decision. Say which it is.
    if (targets.length) lines.push(`${targetsLabel(s)}: ${targets.join(", ")}.`);
    if (s.dailySpendCap != null) lines.push(`Spend budget today: ~Rs ${r(s.dailySpendCap)}.`);
    return { kind, forDate, body: lines.join(" "), payload: { headline: head, nudges: lines.slice(1), stats: pickStats(s) } };
  }

  // evening - only ACTIONABLE nudges (a neutral "on track" if there are none).
  const nudges = [];
  // A shortfall measured against a number he never chose has to say so, or the
  // app spends every evening telling him he failed at someone else's goal. He
  // has been told "protein missed" for 43 consecutive days with `budgets` empty.
  const proteinIsDefault = s.targetSources?.protein_g === "default";
  const caloriesIsDefault = s.targetSources?.calories === "default";
  if (s.proteinTarget) {
    const gap = r(s.proteinTarget) - r(s.proteinToday);
    if (gap > 10) nudges.push(`${gap}g protein to go${proteinIsDefault ? " (app default target)" : ""}`);
  }
  if (s.caloriesTarget) {
    const over = r(s.caloriesToday) - r(s.caloriesTarget);
    if (over > 50) nudges.push(`${over} kcal over target${caloriesIsDefault ? " (app default)" : ""}`);
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
  const headline = nudges.length ? "Evening check-in - a few things left" : "Evening check-in - on track ✓";
  const body = nudges.length ? `${headline}: ${nudges.join(" · ")}.` : `${headline}.`;
  return { kind, forDate, body, payload: { headline, nudges, stats: pickStats(s) } };
}
