import { habitWeights } from "../domain/wellness/habit-weights.js";

export function computeHabitScore(metrics, weights = habitWeights) {
  const weighted = Object.entries(weights).reduce(
    (acc, [key, weight]) => {
      acc.score += (metrics[key] ?? 0) * weight;
      acc.weight += weight;
      return acc;
    },
    { score: 0, weight: 0 },
  );
  return Math.round(weighted.weight ? weighted.score / weighted.weight : 0);
}
