// NEGATION GUARD - "I did NOT go to the gym" must never become a workout row.
//
// The fan-out expander salvages a log whenever a capture *mentions* a domain
// (gym / food / spend). Mention is not occurrence: "no gym today", "skipped
// lunch", "didn't buy it" all name the domain while denying the event. Without
// this guard those captures were auto-applied as real events at confidence 0.6 -
// which is how "Did not go to gym bro" landed in workout_logs, and how the next
// morning's brief told the user they had trained.
//
// Scoping is per CLAUSE, not per capture, so mixed messages keep working:
//   "no gym but ate 6 eggs"      -> gym denied, eggs still logged
//   "Walked 10k steps, no gym"   -> a real walk, so the workout still counts
//
// Pure (no DOM/Supabase) so it's tested directly; the edge function keeps an
// inline mirror (tests/mirror-parity.test.mjs enforces it).

// ==== NEGATION MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====

// Clause boundaries. "but"/"however"/"though" flip polarity, so they split too.
const NEG_CLAUSE_SPLIT = /[,;.!?\n]+|\bbut\b|\bhowever\b|\bthough\b|\balthough\b|\bwhereas\b/i;

// Talking ABOUT a record ("the ai says I did workout") is not a claim that the
// event happened. Without this, a bug report quoting the wrong entry would
// re-create the very row it complains about.
const NEG_REPORTED_SPEECH = /\b(?:it\s+says|says\s+i|said\s+i|shows?|showing|shown|marked|ticked|checked\s+off|the\s+ai|the\s+app|ai\s+note|in\s+the\s+note|according\s+to|thinks\s+i|claims?)\b/i;

// An auxiliary negation attached to an action verb within a few tokens.
const NEG_AUX_VERB = new RegExp(
  "\\b(?:did\\s*n[o']?t|didnt|does\\s*n[o']?t|doesnt|do\\s+not|don'?t|dont|" +
  "was\\s*n[o']?t|wasnt|were\\s*n[o']?t|is\\s*n[o']?t|isnt|" +
  "have\\s*n[o']?t|havent|has\\s*n[o']?t|hasnt|had\\s*n[o']?t|hadnt|" +
  "wo\\s*n[o']?t|wont|will\\s+not|can\\s*not|cannot|can'?t|cant|" +
  "could\\s*n[o']?t|couldnt|should\\s*n[o']?t|shouldnt|ai\\s*n[o']?t|not)\\b" +
  "(?:\\s+\\w+){0,3}\\s+" +
  "\\b(?:go|going|gone|went|do|doing|did|done|make|made|making|hit|attend|attended|" +
  "train|trained|training|work\\s*out|workout|worked|exercise|exercised|lift|lifted|" +
  "eat|eating|ate|eaten|have|having|had|take|taking|took|" +
  "buy|buying|bought|pay|paying|paid|spend|spending|spent|order|ordered|" +
  "drink|drinking|drank|log|logged)\\b",
  "i",
);

// "no <event noun>" - deliberately NOT bare "no", so "rice with no salt" and
// "coffee with no sugar" stay affirmative food logs.
const NEG_NO_EVENT = /\bno\s+(?:gym|workout|work\s?out|exercise|training|session|lifting|cardio|run|walk|breakfast|lunch|dinner|meal|meals|food|snack|eating|spend|spending|purchase|expense)\b/i;

// Standalone denial verbs and idioms.
const NEG_DENIAL_VERB = /\b(?:skip|skips|skipped|skipping|miss|missed|missing|bunk|bunked|ditch|ditched|avoided|refused|declined|forgot\s+to|failed\s+to|gave\s+it\s+a\s+miss)\b/i;
const NEG_IDIOM = /\b(?:rest\s+day|day\s+off|off\s+day|took\s+rest|taking\s+rest|out\s+(?:\S+\s+){0,2}window|couldn'?t\s+make\s+it|not\s+happening|didn'?t\s+happen)\b/i;

// ALREADY RECORDED. Different from a denial and identical in consequence.
//
// A denial says the event did not happen. This says it DID happen and is
// already in the app - "had popcorn today, paid my share, already logged",
// "logged that so I don't want to log it again". Either way we must not write
// a row.
//
// This exists because of the day-journal shape: the owner narrates the whole
// day at night, and most of it is already in from the moment it happened. The
// 2026-08-01 journal re-logged a popcorn and a burrito that were both captured
// hours earlier, taking the day from ~1,850 kcal to 3,315.
const NEG_ALREADY_RECORDED = /\b(?:already\s+(?:\w+\s+){0,2}?(?:logged|added|recorded|entered|captured|tracked|counted|paid|in\s+there|in\s+the\s+app)|(?:logged|added|recorded|captured|counted)\s+(?:it|this|that|them)?\s*already|(?:do\s*n[o']?t|dont|don'?t|no)\s+(?:want\s+to\s+)?(?:log|add|record|count|enter)\s*(?:it|this|that|them)?\s*(?:out\s+)?again|no\s+need\s+to\s+(?:log|add|record|count)|(?:double|twice)[-\s]?(?:log|count|counting|logged|counted))\b/i;

// True when this clause says the event is ALREADY in the app.
export function clauseSaysAlreadyRecorded(clause = "") {
  return NEG_ALREADY_RECORDED.test(String(clause).toLowerCase());
}

// True when this clause denies that its event occurred.
export function clauseDeniesEvent(clause = "") {
  const t = String(clause).toLowerCase();
  if (!t.trim()) return false;
  return NEG_NO_EVENT.test(t) || NEG_AUX_VERB.test(t) || NEG_DENIAL_VERB.test(t) || NEG_IDIOM.test(t);
}

// True when the clause is describing a record rather than asserting an event.
export function clauseIsReportedSpeech(clause = "") {
  return NEG_REPORTED_SPEECH.test(String(clause).toLowerCase());
}

export function splitNegationClauses(text = "") {
  return String(text || "")
    .split(NEG_CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Is the domain DENIED across this whole capture?
//
// `mentions` is a predicate telling us which clauses talk about the domain
// (e.g. looksLikeGym / looksLikeFood). The capture is denied when the domain is
// mentioned somewhere AND every clause that mentions it either denies it or is
// reported speech. One clean affirmative clause is enough to keep the log - that
// is what makes "Walked 10k steps, no gym" still count as a workout.
export function isEventDenied(text = "", mentions) {
  const clauses = splitNegationClauses(text);
  if (!clauses.length) return false;
  const test = typeof mentions === "function" ? mentions : () => true;

  let mentioned = 0;
  let affirmative = 0;
  for (const clause of clauses) {
    if (!test(clause)) continue;
    mentioned++;
    if (clauseDeniesEvent(clause)) continue;
    if (clauseIsReportedSpeech(clause)) continue;
    affirmative++;
  }

  // Nothing in any clause matched the domain, but the whole capture does (the
  // cue straddled a clause boundary) - fall back to whole-text polarity.
  if (mentioned === 0) {
    if (!test(text)) return false;
    return clauseDeniesEvent(text) && !clauseIsReportedSpeech(text);
  }
  return affirmative === 0;
}

// Is this domain ALREADY RECORDED across the capture?
//
// Same clause scoping as isEventDenied, and deliberately the same shape: a
// clause that mentions the domain and says it is already logged suppresses the
// write, while one clean un-flagged clause keeps it. So in
//   "had popcorn today, already logged, then had a burrito"
// the popcorn is suppressed and the burrito still lands.
//
// Returns the matching clauses rather than a bare boolean, because a silent
// drop is the failure mode this codebase keeps repeating - the caller has to be
// able to TELL the user what it chose not to write.
export function alreadyRecordedClauses(text = "", mentions) {
  const test = typeof mentions === "function" ? mentions : () => true;
  const hits = [];
  for (const clause of splitNegationClauses(text)) {
    if (!test(clause)) continue;
    if (clauseSaysAlreadyRecorded(clause)) hits.push(clause);
  }
  return hits;
}

/**
 * Which clauses are covered by an "already logged" flag?
 *
 * The flag almost never sits in the same clause as the thing it refers to.
 * Real dictation:
 *
 *   "the ticket was around 484 I guess"  |  "logged that so I don't want to log it again"
 *    ^ the item                             ^ the flag
 *
 * So a flagged clause covers ITSELF and the clause immediately before it -
 * "already logged" points backwards at what was just said. Returns the set of
 * covered clause indices.
 */
export function alreadyRecordedSpans(text = "") {
  const clauses = splitNegationClauses(text);
  const covered = new Set();
  clauses.forEach((clause, i) => {
    if (!clauseSaysAlreadyRecorded(clause)) return;
    covered.add(i);
    if (i > 0) covered.add(i - 1);
  });
  return { clauses, covered };
}

export function isAlreadyRecorded(text = "", mentions) {
  const clauses = splitNegationClauses(text);
  if (!clauses.length) return false;
  const test = typeof mentions === "function" ? mentions : () => true;
  let mentioned = 0;
  let unflagged = 0;
  for (const clause of clauses) {
    if (!test(clause)) continue;
    mentioned++;
    if (clauseSaysAlreadyRecorded(clause)) continue;
    unflagged++;
  }
  if (mentioned === 0) return test(text) && clauseSaysAlreadyRecorded(text);
  return unflagged === 0;
}

// Gym-specific: did the user DECLARE that no workout happened? Broader than
// isEventDenied because "rest day" / "day off" announce a non-workout without
// naming the gym at all. Used to record an explicit `skipped` workout row, which
// both keeps the phantom out of the streak and stops the evening nudge asking
// about a day the user already answered.
export function declaresNoWorkout(text = "", mentionsGym) {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (NEG_IDIOM.test(t) && !clauseIsReportedSpeech(t)) return true;
  return isEventDenied(t, mentionsGym);
}
// ==== NEGATION MIRROR END ====
