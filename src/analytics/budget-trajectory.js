export function projectMonthlySpend({ spentSoFar, dayOfMonth, daysInMonth = 30 }) {
  if (!dayOfMonth) return 0;
  return Math.round((spentSoFar / dayOfMonth) * daysInMonth);
}

export function getBudgetPace({ spentSoFar, budget, dayOfMonth, daysInMonth = 30 }) {
  const expected = (budget / daysInMonth) * dayOfMonth;
  return {
    expected: Math.round(expected),
    projected: projectMonthlySpend({ spentSoFar, dayOfMonth, daysInMonth }),
    pace: expected ? spentSoFar / expected : 0,
  };
}
