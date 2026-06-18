import { habitWeights } from "../domain/wellness/habit-weights.js";

export function computeHabitScore(metrics, weights = habitWeights) {
  // Normalize over only the habits we actually have data for, so a missing
  // metric (e.g. no hydration logged yet) doesn't unfairly drag the score down
  // and adding a new weighted habit doesn't shift existing scores.
  const weighted = Object.entries(weights).reduce(
    (acc, [key, weight]) => {
      if (metrics[key] == null) return acc;
      acc.score += metrics[key] * weight;
      acc.weight += weight;
      return acc;
    },
    { score: 0, weight: 0 },
  );
  return Math.round(weighted.weight ? weighted.score / weighted.weight : 0);
}
