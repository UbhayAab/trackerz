// NEGATION / SKIP DETECTION — the guard that stops "I didn't go to the gym" from
// being logged as a workout (and "skipped lunch" as a meal). A capture can assert
// that something did NOT happen; the deterministic salvage layer must treat that
// as the ABSENCE of an event, never a log, and never a checklist tick.
//
// Pure (no DOM/Supabase) so it's tested directly; the edge function keeps a
// byte-identical inline mirror, guarded by tests/mirror-parity (NEGATION_RE +
// CLAUSE_SPLIT_RE). One source of truth per concern: this module owns negation,
// fan-out-expander applies it.

// A clause carries a negation when one of these cues appears in it. Bare "no"/"not"
// are included but are only ever evaluated PER CLAUSE (see stripNegatedClauses), so
// a stray "no" ("no excuses, did 5x5") only kills its own clause, never the capture.
export const NEGATION_RE = /\b(?:did(?:n'?t| not)|do(?:n'?t| not)|does(?:n'?t| not)|couldn'?t|could not|can'?t|cannot|wasn'?t|was not|won'?t|will not|wouldn'?t|would not|no|not|skip(?:s|ped|ping)?|missed|missing|bailed|forgot to|failed to)\b/i;

// Clause boundaries: newlines, commas/semicolons, and the conjunctions that scope a
// negation ("skipped gym BUT had dal", "no gym AND ran instead").
export const CLAUSE_SPLIT_RE = /\n|,|;|\bthen\b|\band\b|\bbut\b/i;

// True when a single clause asserts something did not happen.
export function isNegatedClause(clause = "") {
  return NEGATION_RE.test(String(clause || ""));
}

// Remove every clause that asserts something did NOT happen, returning the
// remaining POSITIVE text (what actually did happen). Fast path: text with no
// negation cue at all is returned byte-for-byte unchanged, so every non-negated
// capture behaves exactly as before this guard existed. A wholly negated capture
// ("didn't go to the gym") returns "".
export function stripNegatedClauses(text = "") {
  const s = String(text || "");
  if (!NEGATION_RE.test(s)) return s;
  return s
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter((c) => c && !NEGATION_RE.test(c))
    .join(", ")
    .trim();
}

// True when the capture mentions a skip/absence at all (a negation cue is present).
// Useful for a caller that wants to record a "rest day"/"skipped" note rather than
// silently dropping the capture.
export function describesSkip(text = "") {
  return NEGATION_RE.test(String(text || ""));
}
