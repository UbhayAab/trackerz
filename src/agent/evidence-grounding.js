// Field-level evidence grounding. Before an AI write is auto-applied, confirm
// the load-bearing fields actually appear in the evidence the model read — the
// user's text PLUS the OCR/vision text the model returns. If a field is not
// grounded, the caller demotes the action to review instead of auto-applying.
// This is the main defense against fabricated or prompt-injected writes from
// screenshots (where the dominant capture mode bypasses plain-text filtering).
//
// MIRRORED in supabase/functions/agent/index.ts (isGrounded + helpers). Keep
// the two copies in sync; tests/evidence-grounding.test.mjs locks this one.

// True if the numeric value appears in the evidence as a standalone number
// (commas ignored, digit-boundary aware so 240 does not match inside 1240).
export function evidenceHasNumber(value, evidence) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n) || n === 0) return false;
  const ev = String(evidence || "").replace(/,/g, "");
  const intPart = String(Math.round(n));
  if (new RegExp(`(^|\\D)${intPart}(\\D|$)`).test(ev)) return true;
  if (!Number.isInteger(n)) {
    const dp1 = n.toFixed(1);
    if (new RegExp(`(^|\\D)${dp1.replace(".", "\\.")}(\\D|$)`).test(ev)) return true;
    if (ev.includes(n.toFixed(2))) return true;
  }
  return false;
}

// True if any meaningful word of `text` appears in the evidence.
export function hasWordOverlap(text, evidence, minLen = 3) {
  const ev = String(evidence || "").toLowerCase();
  if (!ev) return false;
  const tokens = String(text || "").toLowerCase().match(new RegExp(`[a-z]{${minLen},}`, "g")) || [];
  return tokens.some((w) => ev.includes(w));
}

export function isGrounded(toolName, args = {}, evidence = "") {
  const ev = String(evidence || "");
  // Note: for write tools, empty evidence yields false below (the number/word
  // helpers return false), which correctly forces review. Non-write tools fall
  // through to the default `true` — they are gated elsewhere, not here.
  switch (toolName) {
    case "create_expense_candidate":
    case "create_income_candidate":
    case "create_transfer_candidate":
    case "create_statement_row_candidate":
      return evidenceHasNumber(args.amount, ev);
    case "create_body_metric_candidate":
      return evidenceHasNumber(args.value, ev);
    case "create_food_log_candidate":
      return hasWordOverlap(args.description, ev) || hasWordOverlap(args.meal_name, ev);
    case "create_wellness_note_candidate":
      return hasWordOverlap(args.note, ev);
    case "create_workout_log_candidate":
      return hasWordOverlap(args.description, ev);
    default:
      return true; // non-write tools are not grounded here
  }
}

export default isGrounded;
