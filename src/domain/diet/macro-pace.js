// Compute how the day's intake so far compares to the share of the day elapsed.
// `pace` is the elapsed fraction of the day in [0, 1] — useful as a "you should
// be roughly at this much by now" reference. `gap` is target minus actual.
//
// Inputs:
//   foodLogs: array of food_log rows (each having `calories_estimate`,
//             `protein_g`, `occurred_at`). Rows without an occurred_at are
//             still counted toward totals but ignored for the time check.
//   target:   { calories, protein_g }
//   now:      optional Date or ISO string — defaults to "latest log time" or now.
//
// Returns: { caloriesSoFar, proteinSoFar, paceForCalories, paceForProtein, gap }
//   where gap = { calories, protein_g } = target - soFar.

const SECONDS_PER_DAY = 24 * 60 * 60;

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayElapsedFraction(now) {
  const start = startOfDay(now).getTime();
  const elapsedSeconds = (now.getTime() - start) / 1000;
  const fraction = elapsedSeconds / SECONDS_PER_DAY;
  if (fraction < 0) return 0;
  if (fraction > 1) return 1;
  return fraction;
}

export function computeMacroPace(foodLogs, target, now) {
  const calorieTarget = Number(target?.calories) || 0;
  const proteinTarget = Number(target?.protein_g) || 0;

  let caloriesSoFar = 0;
  let proteinSoFar = 0;
  let latestLog = null;
  for (const row of foodLogs || []) {
    caloriesSoFar += Number(row.calories_estimate) || 0;
    proteinSoFar += Number(row.protein_g) || 0;
    const at = toDate(row.occurred_at);
    if (at && (!latestLog || at > latestLog)) latestLog = at;
  }

  const reference = toDate(now) || latestLog || new Date();
  const elapsed = dayElapsedFraction(reference);

  return {
    caloriesSoFar: Number(caloriesSoFar.toFixed(2)),
    proteinSoFar: Number(proteinSoFar.toFixed(2)),
    paceForCalories: elapsed,
    paceForProtein: elapsed,
    gap: {
      calories: Number((calorieTarget - caloriesSoFar).toFixed(2)),
      protein_g: Number((proteinTarget - proteinSoFar).toFixed(2)),
    },
  };
}

export default computeMacroPace;
