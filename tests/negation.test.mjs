// NEGATION GUARD — unit coverage for lib/negation.mjs. The regression this locks:
// "I didn't go to the gym" must NOT read as a workout (which was auto-ticking the
// day). Also proves the fast path is byte-identical for non-negated captures, so
// the guard can never change behaviour for a normal log.
import assert from "node:assert/strict";
import { stripNegatedClauses, describesSkip, isNegatedClause, NEGATION_RE, CLAUSE_SPLIT_RE } from "../lib/negation.mjs";
import { looksLikeGym } from "../lib/capture-intent.mjs";
import { looksLikeFood } from "../lib/fan-out-expander.mjs";

// --- fast path: no negation cue -> text returned byte-for-byte unchanged --------
for (const s of [
  "did Workout A, bench 3x10 60kg then leg press 2x12",
  "had dal and 2 rotis for lunch",
  "spent 250 on lunch at a cafe",
  "Rose milk and mushroom sandwich",
  "", "   ",
]) {
  assert.equal(stripNegatedClauses(s), s, `fast path must not touch ${JSON.stringify(s)}`);
}

// --- a wholly negated capture collapses to "" -----------------------------------
for (const s of ["didn't go to the gym today", "no gym today", "skipped gym", "didn't hit the gym", "couldn't make it to gym", "missed my workout"]) {
  assert.equal(stripNegatedClauses(s), "", `${JSON.stringify(s)} should strip to empty`);
  assert.equal(describesSkip(s), true, `${JSON.stringify(s)} is a skip`);
}

// --- mixed: the negated clause is dropped, the positive clause survives ----------
assert.equal(stripNegatedClauses("skipped gym but had dal and 2 rotis"), "had dal, 2 rotis");
assert.equal(stripNegatedClauses("no gym today, ate a banana"), "ate a banana");
assert.equal(stripNegatedClauses("didn't go to the gym but did 20 min walk"), "did 20 min walk");

// --- a stray "no"/"not" only kills its own clause, never a real log --------------
assert.equal(stripNegatedClauses("gym was insane, no excuses, did 5x5"), "gym was insane, did 5x5");

// --- the actual bug, end to end through the detectors ---------------------------
assert.equal(looksLikeGym("didn't go to the gym today"), true, "raw text still trips the gym lexicon (that was the trap)");
assert.equal(looksLikeGym(stripNegatedClauses("didn't go to the gym today")), false, "…but the positive half is not a workout");
assert.equal(looksLikeFood(stripNegatedClauses("skipped lunch")), false, "a skipped meal is not food");
assert.equal(looksLikeFood(stripNegatedClauses("skipped gym but had dal")), true, "the eaten dal survives");

// --- clause helper + exports are the shapes the mirror parity test expects -------
assert.equal(isNegatedClause("didn't go"), true);
assert.equal(isNegatedClause("did legs"), false, "bare 'did' is not a negation");
assert.ok(NEGATION_RE instanceof RegExp && CLAUSE_SPLIT_RE instanceof RegExp);
assert.ok(NEGATION_RE.flags.includes("i"));

console.log("negation tests passed");
