export function scoreFoodDuplicate(a, b) {
  let score = 0;
  if (a.mealSlot && a.mealSlot === b.mealSlot) score += 0.25;
  if (a.occurredAt && b.occurredAt && Math.abs(new Date(a.occurredAt) - new Date(b.occurredAt)) < 90 * 60 * 1000) score += 0.35;
  if (a.description && b.description && shareFoodWords(a.description, b.description)) score += 0.3;
  if (a.sourceMediaId && a.sourceMediaId === b.sourceMediaId) score += 0.25;
  return { score: Math.min(1, Number(score.toFixed(4))), isDuplicate: score >= 0.72 };
}

function shareFoodWords(a, b) {
  const left = new Set(a.toLowerCase().split(/\W+/).filter((word) => word.length > 3));
  return b.toLowerCase().split(/\W+/).some((word) => left.has(word));
}
