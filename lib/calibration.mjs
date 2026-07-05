// Metacognition: once a week the brain checks how often it was WRONG — an
// auto-applied write the user later deleted is a mistake signal. Pure: takes
// last week's auto-applied ai_actions plus the set of applied row ids that
// still exist, returns an error profile + a plain-language line for the weekly
// review. The nightly fn gathers the inputs with service role.

export function calibrate({ actions = [], survivingIds = new Set() } = {}) {
  const byTool = new Map();
  let applied = 0;
  let undone = 0;
  for (const a of actions) {
    if (a.status !== "auto_applied" || !a.applied_record_id) continue;
    applied += 1;
    const gone = !survivingIds.has(a.applied_record_id);
    if (gone) undone += 1;
    const t = byTool.get(a.tool_name) || { applied: 0, undone: 0, confSum: 0 };
    t.applied += 1;
    t.confSum += Number(a.confidence || 0);
    if (gone) t.undone += 1;
    byTool.set(a.tool_name, t);
  }

  const tools = [...byTool.entries()].map(([tool, t]) => ({
    tool,
    applied: t.applied,
    undone: t.undone,
    errorRate: t.applied ? Number((t.undone / t.applied).toFixed(3)) : 0,
    meanConfidence: t.applied ? Number((t.confSum / t.applied).toFixed(3)) : 0,
  })).sort((a, b) => b.undone - a.undone);

  const worst = tools.find((t) => t.undone > 0);
  let line;
  if (!applied) line = "No auto-applied writes this week — nothing to calibrate.";
  else if (!undone) line = `All ${applied} auto-applied writes survived the week — no corrections needed.`;
  else line = `I was wrong on ${undone} of ${applied} auto-applied writes this week${worst ? ` (mostly ${worst.tool.replace(/create_|_candidate/g, "").replace(/_/g, " ")})` : ""} — you deleted them, I logged it.`;

  return { applied, undone, errorRate: applied ? Number((undone / applied).toFixed(3)) : 0, tools, line };
}
