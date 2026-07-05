// Revise-while-writing: humans re-read a sentence when something feels off and
// edit it before moving on. The agent's draft tool calls get the same loop —
// but the CRITIQUE is deterministic (validator errors, missing events, weak
// confidence), and only the REWRITE is a model call, fired only when the gate
// says the draft actually smells. Pure: gate + critique + acceptance test live
// here (mirrored inline in the edge fn); the model call stays in the function.

export const REVISION_MIN_MEAN_CONFIDENCE = 0.75;
export const REVISION_MAX_INPUT_CHARS = 4000;

// Should we spend a second model call on this draft? Only when the
// deterministic layer found concrete problems worth fixing:
//  - the model emitted calls that failed schema validation (rejected), or
//  - the draft is empty while the text clearly contains an event cue, or
//  - mean confidence is low on a multi-call draft (uncertain splitting).
export function needsRevision({ validCalls = [], rejected = [], combinedText = "", meanConfidence = 1 } = {}) {
  const text = String(combinedText || "");
  if (!text.trim() || text.length > REVISION_MAX_INPUT_CHARS) return false;
  const realRejects = rejected.filter((r) => r?.tc?.name && r.tc.name !== "request_user_review");
  if (realRejects.length > 0) return true;
  const onlyReview = validCalls.length > 0 && validCalls.every((c) => c.name === "request_user_review");
  const eventCue = /\b(spent|paid|bought|ate|had|drank|ran|walked|gym|workout|slept|weigh|kg|rs|₹)\b/i.test(text);
  if ((validCalls.length === 0 || onlyReview) && eventCue) return true;
  if (validCalls.length >= 2 && meanConfidence < REVISION_MIN_MEAN_CONFIDENCE) return true;
  return false;
}

// Machine-written critique: the exact complaints, no model in the loop.
export function buildCritique({ validCalls = [], rejected = [], combinedText = "" } = {}) {
  const lines = [];
  for (const r of rejected) {
    if (!r?.tc?.name) continue;
    lines.push(`- Your call "${r.tc.name}" was REJECTED by the validator: ${(r.errors || []).join(", ")}. Fix the arguments or drop it.`);
  }
  const onlyReview = validCalls.length === 0 || validCalls.every((c) => c.name === "request_user_review");
  if (onlyReview && /\b(spent|paid|bought|ate|had|drank|gym|workout|slept)\b/i.test(combinedText)) {
    lines.push("- You produced no concrete event, but the content contains an obvious loggable event cue. Emit the best-guess candidate calls instead of punting.");
  }
  const low = validCalls.filter((c) => Number(c.confidence) < REVISION_MIN_MEAN_CONFIDENCE);
  if (low.length) {
    lines.push(`- ${low.length} call(s) have low confidence — re-read the content and either firm them up or split/merge events correctly.`);
  }
  return lines.join("\n");
}

// Deterministic acceptance: a revision is adopted ONLY if it strictly improves
// the draft — fewer validator rejects, and at least as many concrete writes.
// A model can't talk its way into making things worse.
export function acceptRevision(before, after) {
  const writes = (calls) => calls.filter((c) => c.name !== "request_user_review").length;
  if (after.rejected.length > before.rejected.length) return false;
  if (writes(after.validCalls) < writes(before.validCalls)) return false;
  if (after.rejected.length === before.rejected.length && writes(after.validCalls) === writes(before.validCalls)) return false;
  return true;
}
