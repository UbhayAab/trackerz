export function getInsightSeverity({ pace = 1, confidence = 1 }) {
  if (confidence < 0.72) return "review";
  if (pace > 1.25) return "risk";
  if (pace < 0.85) return "good";
  return "watch";
}
