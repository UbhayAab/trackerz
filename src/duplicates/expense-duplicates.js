import { scoreExpenseDuplicate } from "../../lib/agent-core.mjs";

export function clusterExpenseDuplicates(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const score = scoreExpenseDuplicate(rows[i], rows[j]);
      if (score.score >= 0.6) {
        pairs.push({ a: rows[i].id, b: rows[j].id, ...score });
      }
    }
  }
  return pairs;
}
