export function computeMacroGap({ calories = 0, protein = 0, targets }) {
  return {
    caloriesRemaining: Math.max(0, targets.calories - calories),
    proteinRemaining: Math.max(0, targets.protein - protein),
    proteinProgress: targets.protein ? protein / targets.protein : 0,
  };
}
