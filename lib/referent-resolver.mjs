// REFERENT RESOLVER - "no, 4 eggs not 6" -> WHICH ROW.
//
// The model never emits a row id, and it must never be able to. It emits a
// `target_ref`: the words the user actually said about the thing they mean. This
// module turns those words into exactly one row, or into a question.
//
// Three properties, all of them deliberate:
//
// 1. CLOSED WORLD. Candidates are only rows that were already shown to the model
//    in the memory context, or written during this session. The model cannot
//    reach a row it was never shown, so a hallucinated reference resolves to
//    nothing instead of to somebody else's dinner. buildClosedWorld() is the only
//    way in, and an untagged row is dropped rather than trusted.
//
// 2. NO GUESSING. Two candidates within AMBIGUITY_MARGIN of each other is ALWAYS
//    ambiguous - two identical 6-egg rows always ask. Zero matches is not_found,
//    never a nearest-neighbour guess: the cost of asking is one tap, the cost of
//    editing the wrong row is a number the user will never think to re-check.
//
// 3. RECENCY ALONE NEVER RESOLVES. Recency orders candidates; it never picks one.
//    "the last one" is the single exception, and it is handled as a pronoun with
//    its own rule (below), not as a score.
//
// Scoring priority, in order: exact amount > exact description token match >
// same day + slot > recency. Implemented as decade-separated weights so a pile of
// weak signals can never outrank a strong one.
//
// Pure: no DOM, no Supabase.

// Two candidates whose scores are within this fraction of the top score are
// ambiguous. 5% is wide on purpose - it is not a similarity threshold, it is a
// "do not split hairs on the user's behalf" rule.
export const AMBIGUITY_MARGIN = 0.05;

const W_AMOUNT = 1000;
const W_TOKEN = 100;
const W_DAY = 10;
const W_SLOT = 10;
const W_ANTI = -300; // enough to lose to a single positive token hit

const MEAL_SLOTS = ["breakfast", "lunch", "snack", "dinner", "other"];

// Words that carry no identifying information. "one" is here because "the 250
// one" and "the coffee one" both end in it.
const STOPWORDS = new Set([
  "the", "a", "an", "that", "this", "those", "these", "it", "its", "one", "ones",
  "and", "or", "of", "for", "to", "from", "with", "was", "were", "is", "are", "be",
  "no", "not", "my", "me", "i", "we", "you", "please", "just", "actually", "sorry",
  "delete", "remove", "drop", "undo", "cancel", "change", "fix", "correct", "edit",
  "update", "make", "set", "should", "instead", "rather", "than", "last", "previous",
  "before", "earlier", "today", "yesterday", "row", "entry", "log", "item",
]);

// A bare pronoun reference. These bind ONLY to the immediately preceding capture
// in the same session (see resolveReferent) - never to "whatever is newest in the
// database", which is how an undo lands on a row from three days ago.
const PRONOUN_PHRASES = [
  "that", "it", "this", "that one", "this one", "the last one", "the last",
  "the previous one", "the one before", "those", "them", "the latest one",
];

// "X not Y" splits into what the user means and what they explicitly do not.
const CONTRAST = /\b(?:not|rather than|instead of|nahi)\b/i;

function tokensOf(text) {
  return String(text || "").toLowerCase().match(/[a-z]{2,}/g) || [];
}

function contentTokens(text) {
  return tokensOf(text).filter((t) => !STOPWORDS.has(t));
}

function numbersOf(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n) && n !== 0) out.push(n);
  }
  return out;
}

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Everything about a row that a phrase could name. Numbers come from the typed
// columns AND from the text, because "6 boiled eggs" carries its quantity in the
// description while a Rs 250 lunch carries it in `amount`.
export function normalizeCandidate(row = {}, extra = {}) {
  const text = [row.description, row.meal_name, row.merchant, row.note, row.body, row.title, row.summary]
    .filter((v) => typeof v === "string" && v.trim())
    .join(" ");
  const columnNumbers = [
    row.amount, row.calories_estimate, row.protein_g, row.ml, row.hours,
    row.value, row.duration_min, row.quantity,
  ].map(Number).filter((n) => Number.isFinite(n) && n !== 0);
  return {
    id: row.id,
    table: row.table || extra.table || null,
    source: row.source || extra.source || null,
    occurred_at: row.occurred_at || row.created_at || row.started_at || null,
    slot: MEAL_SLOTS.includes(row.meal_slot) ? row.meal_slot : null,
    text,
    tokens: new Set(tokensOf(text)),
    numbers: new Set([...columnNumbers, ...numbersOf(text)]),
    row,
  };
}

// The ONLY way to build the candidate set. `contextRows` are rows the model was
// shown in the memory context; `sessionRows` are rows written during this
// session. Anything else is not in the world and cannot be referred to.
export function buildClosedWorld({ contextRows = [], sessionRows = [] } = {}) {
  const out = [];
  const seen = new Set();
  for (const [rows, source] of [[sessionRows, "session"], [contextRows, "context"]]) {
    for (const row of rows || []) {
      if (!row || !row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(normalizeCandidate(row, { source }));
    }
  }
  return out;
}

// Split "X not Y" into the part that identifies the row and the part that
// explicitly rules one out.
//
// The same surface form means two opposite things and the difference is what is
// on the right of the marker:
//   "the coffee not the tea"  -> SELECTION. Both sides name a thing; the left one
//                                is the target and the right one is an anti-cue.
//   "no, 4 eggs not 6"        -> CORRECTION. The right side is a bare number, so
//                                it is the OLD value and therefore identifies the
//                                existing row; the left number is the new value
//                                and identifies nothing.
export function splitContrast(text) {
  const raw = String(text || "");
  const m = raw.match(CONTRAST);
  if (!m || m.index == null) {
    return { kind: "none", identify: raw, anti: "", identifyNumbers: numbersOf(raw) };
  }
  const positive = raw.slice(0, m.index);
  const negative = raw.slice(m.index + m[0].length);
  if (!contentTokens(negative).length) {
    // Correction: the number after "not" is the value being replaced, so it is
    // what points at the row. The number before it is the replacement.
    return { kind: "correction", identify: positive, anti: "", identifyNumbers: numbersOf(negative) };
  }
  return { kind: "selection", identify: positive, anti: negative, identifyNumbers: numbersOf(positive) };
}

function slotIn(text) {
  const t = String(text || "").toLowerCase();
  return MEAL_SLOTS.find((s) => new RegExp(`\\b${s}\\b`).test(t)) || null;
}

// Is the whole reference just a pronoun, once the verb is stripped?
export function isBarePronoun(ref) {
  const t = String(ref || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  // Strip a leading command verb ("delete that", "undo it", "remove that one").
  const stripped = t.replace(/^(please\s+)?(delete|remove|drop|undo|cancel|kill|scrap|bin)\s+/, "").trim();
  return PRONOUN_PHRASES.includes(stripped);
}

function scoreCandidate(cand, parsed, refDayKey, refSlot) {
  let score = 0;
  const signals = [];
  let amountHits = 0;
  for (const n of parsed.numbers) if (cand.numbers.has(n)) amountHits += 1;
  if (amountHits) { score += Math.min(amountHits, 2) * W_AMOUNT; signals.push("amount"); }

  let tokenHits = 0;
  for (const t of parsed.tokens) if (cand.tokens.has(t)) tokenHits += 1;
  if (tokenHits) { score += Math.min(tokenHits, 8) * W_TOKEN; signals.push("token"); }

  if (refDayKey && cand.occurred_at && dayKey(cand.occurred_at) === refDayKey) { score += W_DAY; signals.push("day"); }
  if (refSlot && cand.slot === refSlot) { score += W_SLOT; signals.push("slot"); }

  let antiHits = 0;
  for (const t of parsed.antiTokens) if (cand.tokens.has(t)) antiHits += 1;
  for (const n of parsed.antiNumbers) if (cand.numbers.has(n)) antiHits += 1;
  if (antiHits) { score += antiHits * W_ANTI; signals.push("excluded"); }

  return { score, signals };
}

function recencyOf(cand) {
  const t = new Date(cand.occurred_at || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function describeCandidate(cand) {
  const c = cand && cand.tokens ? cand : normalizeCandidate(cand || {});
  const when = c.occurred_at ? new Date(c.occurred_at).toISOString().slice(11, 16) : "";
  const label = c.text ? c.text.slice(0, 48) : (c.table || "row");
  return when ? `${label} (${when})` : label;
}

// Resolve a `target_ref` phrase against the closed world.
//
// options:
//   now         - ISO string; the day "today"/"same day" is measured against.
//   lastCapture - { rows: [...] } the IMMEDIATELY preceding capture in this
//                 session. A bare pronoun binds here and nowhere else, and only
//                 when that capture wrote exactly one row.
export function resolveReferent(ref, candidates = [], { now = null, lastCapture = null } = {}) {
  const world = (candidates || []).filter((c) => c && c.id && (c.source === "context" || c.source === "session"));
  const text = String(ref || "").trim();
  if (!text) return { status: "not_found", reason: "empty_ref", candidates: [] };

  // --- pronouns -------------------------------------------------------------
  // "delete that". A pronoun has no content of its own, so the only honest
  // binding is the thing that was just said. Anything else - newest row in the
  // table, highest-scoring row in the world - is a guess wearing a rule.
  if (isBarePronoun(text)) {
    const rows = (lastCapture?.rows || []).filter(Boolean);
    if (!rows.length) return { status: "not_found", reason: "no_preceding_capture", candidates: [] };
    if (rows.length > 1) {
      return {
        status: "ambiguous",
        reason: "preceding_capture_wrote_many",
        candidates: rows.slice(0, 3).map((r) => (r.tokens ? r : normalizeCandidate(r))),
      };
    }
    const only = rows[0].tokens ? rows[0] : normalizeCandidate(rows[0]);
    return { status: "resolved", row: only.row || only, score: W_AMOUNT, via: "pronoun", candidate: only };
  }

  if (!world.length) return { status: "not_found", reason: "closed_world_empty", candidates: [] };

  const split = splitContrast(text);
  const parsed = {
    tokens: new Set(contentTokens(split.identify)),
    numbers: new Set(split.identifyNumbers),
    antiTokens: new Set(contentTokens(split.anti)),
    antiNumbers: new Set(numbersOf(split.anti)),
  };
  const refSlot = slotIn(split.identify);
  const refDayKey = /\btoday\b/i.test(text) && now ? dayKey(now) : "";

  if (!parsed.tokens.size && !parsed.numbers.size && !refSlot) {
    return { status: "not_found", reason: "no_identifying_terms", candidates: [] };
  }

  const scored = world
    .map((cand) => ({ cand, ...scoreCandidate(cand, parsed, refDayKey, refSlot) }))
    .filter((s) => s.score > 0)
    // Recency is a TIEBREAK ORDER, never a score: it decides which of two equally
    // good matches is listed first in the ambiguity card, and nothing else.
    .sort((a, b) => (b.score - a.score) || (recencyOf(b.cand) - recencyOf(a.cand)));

  if (!scored.length) return { status: "not_found", reason: "no_match", candidates: [] };

  const top = scored[0];
  const second = scored[1];
  if (second && (top.score - second.score) / top.score < AMBIGUITY_MARGIN) {
    return {
      status: "ambiguous",
      reason: "within_margin",
      candidates: scored.slice(0, 3).map((s) => s.cand),
      scores: scored.slice(0, 3).map((s) => s.score),
    };
  }

  return { status: "resolved", row: top.cand.row || top.cand, score: top.score, via: top.signals.join("+"), candidate: top.cand };
}

export default resolveReferent;
