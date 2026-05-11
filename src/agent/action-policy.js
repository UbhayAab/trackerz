import { getTool } from "./tool-registry.js";

export const confidencePolicy = {
  autoApply: 0.88,
  review: 0.72,
};

export function decideActionPolicy(action) {
  const tool = getTool(action.name);
  const confidence = Number(action.confidence ?? 0);
  const reasons = [];

  if (!tool) reasons.push("unknown_tool");
  if (tool?.destructive) reasons.push("destructive_blocked");
  if (!action.evidenceId) reasons.push("missing_evidence");
  if (confidence < confidencePolicy.review) reasons.push("low_confidence");
  if (action.risk === "high") reasons.push("high_risk");

  if (reasons.includes("unknown_tool") || reasons.includes("destructive_blocked")) {
    return { mode: "block", reasons };
  }

  if (reasons.length > 0 || confidence < confidencePolicy.autoApply) {
    return { mode: "review", reasons };
  }

  return { mode: "auto_apply", reasons };
}
