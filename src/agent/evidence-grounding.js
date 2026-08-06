// Field-level evidence grounding. Before an AI write is auto-applied, confirm
// the load-bearing fields actually appear in the evidence the model read - the
// user's text PLUS the OCR/vision text the model returns. If a field is not
// grounded, the caller demotes the action to review instead of auto-applying.
// This is the main defense against fabricated or prompt-injected writes from
// screenshots (where the dominant capture mode bypasses plain-text filtering).
//
// MIRRORED in supabase/functions/agent/index.ts (isGrounded + helpers). Keep
// the two copies in sync; tests/evidence-grounding.test.mjs locks this one.

import { SCHEDULE_CUE } from "../../lib/schedule-args.mjs";

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

// A sleep WINDOW is emitted as ISO ("...T23:30:00+05:30") while the user typed
// "bed at 11:30, up at 6:30", so the raw figure never matches. Match the wall
// clock instead, in both 24h and 12h form.
export function evidenceHasClockTime(iso, evidence) {
  const m = String(iso || "").match(/T(\d{2}):(\d{2})/);
  if (!m) return false;
  const ev = String(evidence || "").toLowerCase();
  if (!ev) return false;
  const h24 = Number(m[1]);
  const mins = m[2];
  const hours = [String(h24), String(h24 % 12 === 0 ? 12 : h24 % 12)];
  return hours.some((h) =>
    new RegExp(`(^|\\D)${h}\\s*[:.]\\s*${mins}(\\D|$)`).test(ev) ||
    new RegExp(`(^|\\D)${h}\\s*(am|pm|o'clock)`).test(ev));
}

// A bedtime marker carries no figure at all - the app explicitly accepts
// "going to sleep now" as a sleep row - so the only thing left to ground is that
// the evidence is about sleep in the first place.
const SLEEP_EVIDENCE_CUE = /\b(sleep|slept|sleeping|asleep|bed|bedtime|nap|napped|napping|woke|wake|waking|snooze|lights out)\b/i;

// Every human-readable phrase in a plan payload: meal and workout names, the raw
// exercise lines, and the "match" string a delta op targets. The op CODE is
// deliberately NOT collected - "add_meal" tokenises to "add"/"meal" and would
// word-match "add a salad bowl", which would ground literally any plan rewrite.
const PLAN_PHRASE_KEYS = new Set(["name", "detail", "match", "exercise", "title", "summary", "note"]);
export function planPhrases(node, depth = 0, out = []) {
  if (node == null || depth > 5) return out;
  if (Array.isArray(node)) {
    for (const v of node) {
      if (typeof v === "string") out.push(v);
      else planPhrases(v, depth + 1, out);
    }
    return out;
  }
  if (typeof node !== "object") return out;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === "string") { if (PLAN_PHRASE_KEYS.has(k)) out.push(v); }
    else planPhrases(v, depth + 1, out);
  }
  return out;
}

export function isGrounded(toolName, args = {}, evidence = "") {
  const ev = String(evidence || "");
  // EVERY member of WRITE_TOOLS needs its own case here. Seven of them - plan,
  // target, memory, note, reminder, hydration, sleep - used to fall straight
  // through to `default: true` while the comment above them claimed only non-write
  // tools did. So the three highest-leverage row types in the app (the plan, the
  // targets, and the durable memory that is fed back into every later prompt) were
  // written with no field check at all, and a screenshot of somebody else's meal
  // plan could replace the owner's. tests/evidence-grounding.test.mjs now fails the
  // build the moment a write tool is missing from this switch.
  //
  // Empty evidence makes the number/word helpers return false, so write tools
  // cannot be grounded by nothing; non-write tools fall through to `default`.
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
    case "set_target_candidate":
      // A target the user never said a number for is a hallucination by
      // definition. This does flag the TARGET CASCADE derivations ("lean bulk to
      // 90kg" -> daily_calories 2300), and that is the correct reading: 2300 is
      // the model's invention, not a figure the owner gave.
      return evidenceHasNumber(args.amount, ev);
    case "create_hydration_candidate": {
      const ml = Number(args.ml);
      // Litres are the other common spelling ("1 litre" -> ml 1000). Only for a
      // whole number of litres, so a 500 ml row can never ground on a stray "1".
      if (Number.isFinite(ml) && ml >= 1000 && ml % 1000 === 0 && evidenceHasNumber(ml / 1000, ev)) return true;
      return evidenceHasNumber(ml, ev);
    }
    case "create_sleep_candidate": {
      // Three shapes and only one of them carries a number. A stated duration IS
      // the load-bearing field and must appear (floor accepted too, so "about 6
      // and a half hours" -> 6.5 still matches the 6 the user typed). A window
      // grounds on its wall clock. A bare marker has no figure to check.
      const clock = evidenceHasClockTime(args.started_at, ev) || evidenceHasClockTime(args.ended_at, ev);
      if (args.hours != null && args.hours !== "") {
        return evidenceHasNumber(args.hours, ev)
          || evidenceHasNumber(Math.floor(Number(args.hours)), ev)
          || clock;
      }
      return clock || SLEEP_EVIDENCE_CUE.test(ev);
    }
    case "update_plan_candidate": {
      // A plan write replaces the owner's whole diet or gym schedule, or rewrites
      // a day of it. Ground it on the words: at least one meal / exercise name, or
      // the summary, has to appear in what the user said or what the OCR read.
      // minLen 4 because a 3-letter token grounds on nothing - "day" sits inside
      // "today", which turns up in almost every capture.
      const phrases = planPhrases(args.payload);
      if (typeof args.summary === "string") phrases.push(args.summary);
      if (phrases.some((p) => hasWordOverlap(p, ev, 4))) return true;
      // A targets-only delta ({ op:"set_targets", targets:{ calories:1800 } })
      // has no words at all - ground it on the figure, same rule as a target row.
      const targets = args.payload && typeof args.payload === "object" ? args.payload.targets : null;
      if (targets && typeof targets === "object") {
        return Object.keys(targets).some((k) => evidenceHasNumber(targets[k], ev));
      }
      return false;
    }
    case "remember_fact":
      // Durable memory is replayed into EVERY later prompt, so a fabricated fact
      // does not decay with the capture that made it - it compounds.
      //
      // The value is often a bare figure ("monthly_budget" -> "500000"), and
      // hasWordOverlap tokenises on [a-z] only, so EVERY numeric fact used to
      // read as ungrounded. That was not merely a stale low_evidence tag: the
      // provenance gate asks this function WHICH span supports a call, and a
      // numeric fact that grounds in nothing grounds equally in nothing on
      // both sides - so a budget figure lifted out of a photograph could not be
      // attributed to the photograph. Same rule as a target: the number has to
      // appear in what the model actually read.
      return hasWordOverlap(args.value, ev) || evidenceHasNumber(args.value, ev);
    case "create_note_candidate":
      return hasWordOverlap(args.body, ev);
    case "create_reminder_candidate":
      return hasWordOverlap(args.title, ev);
    case "schedule_task_candidate":
      // A task the app runs on its own later, so a hallucinated one is a
      // notification about something the user never asked for. The prompt is
      // written BY the model, so it cannot be required to echo the evidence -
      // what must be grounded is that scheduling was actually asked for.
      return SCHEDULE_CUE.test(String(ev || ""));
    default:
      return true;
  }
}

export default isGrounded;
