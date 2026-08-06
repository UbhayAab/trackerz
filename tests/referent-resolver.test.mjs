// REFERENT RESOLVER - "no, 4 eggs not 6" -> WHICH ROW.
//
// The three properties under test are the three ways an edit tool goes wrong:
// reaching a row the model was never shown, guessing between two matches, and
// resolving on recency alone.
import assert from "node:assert/strict";
import {
  resolveReferent, buildClosedWorld, normalizeCandidate, splitContrast,
  isBarePronoun, describeCandidate, AMBIGUITY_MARGIN,
} from "../lib/referent-resolver.mjs";

const T = (h, m = 0) => `2026-08-06T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`;

const eggs6 = { id: "f1", table: "food_logs", description: "6 boiled eggs", meal_slot: "breakfast", calories_estimate: 432, occurred_at: T(8) };
const coffee = { id: "f2", table: "food_logs", description: "coffee with milk", meal_slot: "snack", calories_estimate: 60, occurred_at: T(11) };
const tea = { id: "f3", table: "food_logs", description: "masala tea", meal_slot: "snack", calories_estimate: 70, occurred_at: T(16) };
const lunch250 = { id: "l1", table: "ledger_entries", merchant: "Rolls corner", description: "lunch", amount: 250, occurred_at: T(13) };
const dinner640 = { id: "l2", table: "ledger_entries", merchant: "Dmart", description: "groceries", amount: 640, occurred_at: T(19) };

const world = () => buildClosedWorld({ contextRows: [eggs6, coffee, tea, lunch250, dinner640] });

// ---- the closed world ------------------------------------------------------
// Candidates are only rows the model was SHOWN or wrote this session. A row it
// invented, or one that arrived from anywhere else, is not reachable.
{
  const w = world();
  assert.equal(w.length, 5);
  assert.ok(w.every((c) => c.source === "context"));
  // Untagged rows are dropped rather than trusted.
  const smuggled = [normalizeCandidate({ id: "x9", description: "6 boiled eggs" })];
  assert.deepEqual(resolveReferent("6 eggs", smuggled), { status: "not_found", reason: "closed_world_empty", candidates: [] });
  assert.equal(resolveReferent("6 eggs", []).status, "not_found");
  // Session rows win the de-dupe when the same id appears in both lists.
  const both = buildClosedWorld({ contextRows: [eggs6], sessionRows: [eggs6] });
  assert.equal(both.length, 1);
  assert.equal(both[0].source, "session");
}

// ---- "no, 4 eggs not 6" ----------------------------------------------------
// A CORRECTION: the number after "not" is the OLD value, so it is what points at
// the existing row. The 4 is the replacement and identifies nothing.
{
  const split = splitContrast("no, 4 eggs not 6");
  assert.equal(split.kind, "correction");
  assert.deepEqual(split.identifyNumbers, [6], "the 6 identifies the row, the 4 does not");

  const out = resolveReferent("no, 4 eggs not 6", world());
  assert.equal(out.status, "resolved");
  assert.equal(out.row.id, "f1");
}

// ---- "the coffee not the tea" ----------------------------------------------
// A SELECTION: both sides name a thing, so the right side is an ANTI-cue.
{
  const split = splitContrast("the coffee not the tea");
  assert.equal(split.kind, "selection");
  assert.match(split.anti, /tea/);

  const out = resolveReferent("the coffee not the tea", world());
  assert.equal(out.status, "resolved");
  assert.equal(out.row.id, "f2", "the coffee, and specifically not the tea");
}

// ---- "remove the 250 one" --------------------------------------------------
{
  const out = resolveReferent("remove the 250 one", world());
  assert.equal(out.status, "resolved");
  assert.equal(out.row.id, "l1");
  assert.match(out.via, /amount/);
}

// ---- "delete that" - the pronoun rule --------------------------------------
// A bare pronoun binds ONLY to the immediately preceding capture in this session,
// and only when that capture wrote exactly one row. Never to "newest in the
// table", which is how an undo lands on a row from three days ago.
{
  assert.equal(isBarePronoun("delete that"), true);
  assert.equal(isBarePronoun("that"), true);
  assert.equal(isBarePronoun("the last one"), true);
  assert.equal(isBarePronoun("remove that one"), true);
  assert.equal(isBarePronoun("delete the coffee"), false);

  const one = resolveReferent("delete that", world(), { lastCapture: { rows: [normalizeCandidate(tea, { source: "session" })] } });
  assert.equal(one.status, "resolved");
  assert.equal(one.via, "pronoun");
  assert.equal(one.row.id, "f3");

  // The preceding capture wrote TWO rows - "that" does not name one of them.
  const many = resolveReferent("delete that", world(), {
    lastCapture: { rows: [normalizeCandidate(coffee, { source: "session" }), normalizeCandidate(lunch250, { source: "session" })] },
  });
  assert.equal(many.status, "ambiguous");
  assert.equal(many.reason, "preceding_capture_wrote_many");
  assert.equal(many.candidates.length, 2);

  // No preceding capture: a pronoun with nothing behind it resolves to NOTHING,
  // even though the world is full of plausible rows.
  const none = resolveReferent("delete that", world());
  assert.equal(none.status, "not_found");
  assert.equal(none.reason, "no_preceding_capture");
}

// ---- two identical rows always ask -----------------------------------------
{
  const twin = { ...eggs6, id: "f1b", occurred_at: T(9) };
  const w = buildClosedWorld({ contextRows: [eggs6, twin] });
  const out = resolveReferent("the 6 eggs", w);
  assert.equal(out.status, "ambiguous", "two identical 6-egg rows always ask");
  assert.equal(out.candidates.length, 2);
  assert.equal(out.scores[0], out.scores[1], "an exact tie, and recency did not break it");
}

// ---- zero matches is not_found, never a nearest neighbour -------------------
{
  const out = resolveReferent("the paneer tikka", world());
  assert.equal(out.status, "not_found");
  assert.equal(out.reason, "no_match");
  assert.equal(out.candidates.length, 0, "a not_found offers no consolation guess");
  // A reference made entirely of stopwords identifies nothing.
  assert.equal(resolveReferent("the one", world()).reason, "no_identifying_terms");
  assert.equal(resolveReferent("", world()).reason, "empty_ref");
}

// ---- recency alone never resolves ------------------------------------------
// Five rows, a phrase that matches none of them, and the newest row sitting right
// there. It must still be not_found.
{
  const out = resolveReferent("the biryani", world());
  assert.equal(out.status, "not_found");

  // Even with a day+slot hint shared by two rows, recency does not pick between
  // them - the tie stands and the user is asked.
  const snacks = buildClosedWorld({ contextRows: [coffee, tea] });
  const bySlot = resolveReferent("the snack", snacks, { now: T(20) });
  assert.equal(bySlot.status, "ambiguous", "two rows in the same slot is a question, not a race");
}

// ---- the margin ------------------------------------------------------------
{
  assert.equal(AMBIGUITY_MARGIN, 0.05);
  // A single strong match well clear of the field resolves.
  const clear = resolveReferent("the groceries at dmart", world());
  assert.equal(clear.status, "resolved");
  assert.equal(clear.row.id, "l2");
}

// ---- describeCandidate is safe on a raw row --------------------------------
assert.match(describeCandidate(eggs6), /6 boiled eggs/);

// ---------------------------------------------------------------------------
// FUZZ. Half the corpus is built as an EXACT TIE - two rows identical in every
// field the scorer reads, differing only in id and timestamp. `resolved` must
// never come back for one of those, whatever the phrasing.
// ---------------------------------------------------------------------------
{
  const NOUNS = ["eggs", "curd", "paneer", "coffee", "rice", "dal", "chapati", "milk"];
  const PHRASES = [
    (n, q) => `the ${n}`,
    (n, q) => `remove the ${q} one`,
    (n, q) => `delete the ${n}`,
    (n, q) => `no, ${q - 1} ${n} not ${q}`,
    (n, q) => `${q} ${n}`,
    (n, q) => `the ${q} ${n} one`,
  ];
  let ties = 0;
  let resolvedTies = 0;
  let uniques = 0;
  let resolvedUniques = 0;
  for (let i = 0; i < 480; i += 1) {
    const noun = NOUNS[i % NOUNS.length];
    const qty = 2 + (i % 7);
    const phrase = PHRASES[i % PHRASES.length](noun, qty);
    const rowA = { id: `a${i}`, table: "food_logs", description: `${qty} ${noun}`, meal_slot: "snack", occurred_at: T(9) };
    if (i % 2 === 0) {
      // EXACT TIE: identical description, identical slot, different id + time.
      const rowB = { ...rowA, id: `b${i}`, occurred_at: T(17) };
      const out = resolveReferent(phrase, buildClosedWorld({ contextRows: [rowA, rowB] }));
      ties += 1;
      if (out.status === "resolved") resolvedTies += 1;
      assert.notEqual(out.status, "resolved", `TIE RESOLVED on ${JSON.stringify(phrase)} - recency broke a tie it must not break`);
    } else {
      // A single distinguishable row plus a decoy that shares nothing.
      const decoy = { id: `d${i}`, table: "food_logs", description: "leftover khichdi", meal_slot: "dinner", occurred_at: T(21) };
      const out = resolveReferent(phrase, buildClosedWorld({ contextRows: [rowA, decoy] }));
      uniques += 1;
      if (out.status === "resolved") resolvedUniques += 1;
      assert.notEqual(out.status, "error");
      if (out.status === "resolved") assert.equal(out.row.id, rowA.id, `resolved to the wrong row for ${JSON.stringify(phrase)}`);
    }
  }
  assert.equal(resolvedTies, 0, "not one exact tie may resolve");
  assert.equal(ties, 240);
  // The resolver must still be USEFUL: a distinguishable row should mostly
  // resolve, or "never guess" has quietly become "never answer".
  assert.ok(resolvedUniques / uniques > 0.75, `only ${resolvedUniques}/${uniques} distinguishable refs resolved`);
}

console.log("referent-resolver tests passed");
