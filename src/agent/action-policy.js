import { getTool } from "./tool-registry.js";
import { mutationRisk, tierRank } from "../../lib/mutation-risk.mjs";

export const confidencePolicy = {
  autoApply: 0.88,
  review: 0.72,
};

// The three outcomes. `confirm` is NEW: before it existed the only choices were
// "commit it silently" and "refuse it", so every tool the model could reach had
// to be one or the other, and a permanent plan rewrite got the same treatment as
// a 100 ml water log. See lib/mutation-risk.mjs for what puts an action in each.
export const ACTION_MODES = ["auto_apply", "confirm", "block"];

export function decideActionPolicy(action) {
  const tool = getTool(action.name);
  const confidence = Number(action.confidence ?? 0);
  const reasons = [];

  if (!tool) reasons.push("unknown_tool");
  if (tool?.destructive) reasons.push("destructive");
  if (!action.evidenceId) reasons.push("missing_evidence");
  if (confidence < confidencePolicy.review) reasons.push("low_confidence");
  if (action.risk === "high") reasons.push("high_risk");

  // An UNKNOWN tool is still blocked outright, and that is the case this branch
  // was really protecting: a name nobody classified has no tier, no schema and no
  // handler.
  //
  // A REGISTERED destructive tool is no longer blocked. It used to be, because
  // there was nowhere else to put it - the app had `block` and `auto_apply` and
  // nothing in between, so "change the row I logged at 15:14" could only be
  // committed silently or refused. `confirm` exists now: mutationGate returns
  // "hard" for every destructive tool, which means a diff card and one tap, and
  // mutationRisk marks it softDeleteOnly so the write is a tombstone rather than
  // a removal. Blocking here would mean amend/delete can never reach the user at
  // all, which is not safety - it is the old behaviour where a correction wrote a
  // SECOND row and the day counted both.
  if (reasons.includes("unknown_tool")) {
    return { mode: "block", tier: "destructive", gate: "blocked", reasons };
  }

  const risk = mutationRisk(action);

  // Above `reversible` the write does not just add a row - it rewrites the
  // standing setup, destroys something already recorded, or leaves the app. Those
  // stop here and wait for a tap. `gate: "hard"` means a diff card; `gate: "soft"`
  // is a date-scoped plan delta, which still auto-applies but carries an undo
  // toast (risk.undoToastMs) so it is reversible in one tap for 15 seconds.
  if (risk.gate === "hard") {
    return {
      mode: "confirm",
      tier: risk.tier,
      gate: risk.gate,
      softDeleteOnly: risk.softDeleteOnly,
      reasons: [...reasons, `confirm_${risk.tier}`],
    };
  }

  // No approve gate for a reversible capture: commit it straight away. `reasons`
  // (low_confidence / missing_evidence / high_risk) are kept so the UI can flag a
  // weak addition in the feed - the user deletes anything wrong instead of
  // approving everything up front.
  return {
    mode: "auto_apply",
    tier: risk.tier,
    gate: risk.gate,
    undoToastMs: risk.undoToastMs,
    reasons,
  };
}

// The invariant, callable rather than merely described: in an autonomous context
// (a cron-fired run, a background retry - nobody at the other end of the round
// trip) nothing above `reversible` may apply itself. Returns the offending
// actions, so a test or a runtime guard can assert it is empty.
export function autonomousViolations(actions = []) {
  return (Array.isArray(actions) ? actions : []).filter((a) => {
    const decision = decideActionPolicy(a || {});
    return decision.mode === "auto_apply" && tierRank(decision.tier) > 0;
  });
}
