// REFERENT RESOLVER - "no, 4 eggs not 6" -> WHICH ROW.
//
// The model never emits a row id, and it must never be able to. It emits a
// `target_ref`: the words the user actually said about the thing they mean. This
// module turns those words into exactly one row, or into a question.
//
// Three properties, all of them deliberate:
//
// 1. CLOSED WORLD. Candidates are only rows that were already shown to the model
//    in the memory context, written during this session, or - for an amendment -
//    the rows that actually sit inside the DATE WINDOW the user named. The model
//    cannot reach a row it was never shown or that is outside the window, so a
//    hallucinated reference resolves to nothing instead of to somebody else's
//    dinner. buildClosedWorld() / buildWindowWorld() are the only ways in, and an
//    untagged row is dropped rather than trusted.
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
// Pure: no DOM, no Supabase, no clock. MIRRORED byte-identically into
// supabase/functions/agent/index.ts (lib/amend-target.mjs needs it there, and a
// second matcher written for the server is exactly the drift this repo keeps
// paying for) - run `node scripts/sync-mirror.mjs` after editing the block below.

// ==== REFERENT-RESOLVER MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====

// Two candidates whose scores are within this fraction of the top score are
// ambiguous. 5% is wide on purpose - it is not a similarity threshold, it is a
// "do not split hairs on the user's behalf" rule.
var AMBIGUITY_MARGIN = 0.05;

var W_AMOUNT = 1000;
var W_TOKEN = 100;
var W_DAY = 10;
var W_SLOT = 10;
var W_ANTI = -300; // enough to lose to a single positive token hit

var MEAL_SLOTS = ["breakfast", "lunch", "snack", "dinner", "other"];

// The three ways a row can enter the world. `context` = it was in the memory
// block the model read; `session` = this capture wrote it; `window` = it sits
// inside the calendar window the user named out loud. Anything else is not in
// the world and cannot be referred to.
var CANDIDATE_SOURCES = ["context", "session", "window"];

// Words that carry no identifying information. "one" is here because "the 250
// one" and "the coffee one" both end in it.
var STOPWORDS = new Set([
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
var PRONOUN_PHRASES = [
  "that", "it", "this", "that one", "this one", "the last one", "the last",
  "the previous one", "the one before", "those", "them", "the latest one",
];

// "X not Y" splits into what the user means and what they explicitly do not.
var CONTRAST = /\b(?:not|rather than|instead of|nahi)\b/i;

function tokensOf(text) {
  return String(text || "").toLowerCase().match(/[a-z]{2,}/g) || [];
}

function contentTokens(text) {
  return tokensOf(text).filter(function (t) { return !STOPWORDS.has(t); });
}

function numbersOf(text) {
  var out = [];
  var matches = String(text || "").match(/\d+(?:\.\d+)?/g) || [];
  for (var i = 0; i < matches.length; i++) {
    var n = Number(matches[i]);
    if (Number.isFinite(n) && n !== 0) out.push(n);
  }
  return out;
}

// A LOCAL-zone-free day key, used only to compare two rows against each other and
// against a key the caller already computed in the user's zone. It never invents
// a day for the user: callers that care about the calendar (lib/amend-target.mjs)
// pass a key derived from saDayKey/dayKeyInTz and this only has to agree with
// itself. Kept off toISOString().slice(0,10) all the same.
function rrDayKey(iso) {
  var d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Everything about a row that a phrase could name. Numbers come from the typed
// columns AND from the text, because "6 boiled eggs" carries its quantity in the
// description while a Rs 250 lunch carries it in `amount`.
function normalizeCandidate(row = null, extra = null) {
  var r = row || {};
  var e = extra || {};
  var textParts = [r.description, r.meal_name, r.merchant, r.note, r.body, r.title, r.summary];
  var kept = [];
  for (var i = 0; i < textParts.length; i++) {
    if (typeof textParts[i] === "string" && textParts[i].trim()) kept.push(textParts[i]);
  }
  var text = kept.join(" ");
  var rawNumbers = [r.amount, r.calories_estimate, r.protein_g, r.ml, r.hours, r.value, r.duration_min, r.quantity];
  var columnNumbers = [];
  for (var j = 0; j < rawNumbers.length; j++) {
    var n = Number(rawNumbers[j]);
    if (Number.isFinite(n) && n !== 0) columnNumbers.push(n);
  }
  return {
    id: r.id,
    table: r.table || e.table || null,
    source: r.source || e.source || null,
    occurred_at: r.occurred_at || r.created_at || r.started_at || null,
    day_key: r.day_key || e.day_key || null,
    slot: MEAL_SLOTS.indexOf(r.meal_slot) >= 0 ? r.meal_slot : null,
    text: text,
    tokens: new Set(tokensOf(text)),
    numbers: new Set(columnNumbers.concat(numbersOf(text))),
    row: r,
  };
}

// The ONLY way to build the candidate set from a conversation. `contextRows` are
// rows the model was shown in the memory context; `sessionRows` are rows written
// during this session. Anything else is not in the world.
function buildClosedWorld(opts = null) {
  var o = opts || {};
  var out = [];
  var seen = new Set();
  var groups = [[o.sessionRows || [], "session"], [o.contextRows || [], "context"]];
  for (var g = 0; g < groups.length; g++) {
    var rows = groups[g][0];
    var source = groups[g][1];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(normalizeCandidate(row, { source: source }));
    }
  }
  return out;
}

// The candidate set for an AMENDMENT: every row that actually sits inside the
// calendar window the user named. `dayKeyOf` is supplied by the caller so the
// zone arithmetic lives in exactly one place (lib/amend-target.mjs, over
// lib/tz.mjs) and this module never has to guess what day an instant belongs to.
function buildWindowWorld(rows, dayKeyOf = null) {
  var list = Array.isArray(rows) ? rows : [];
  var out = [];
  var seen = new Set();
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    var key = null;
    if (typeof dayKeyOf === "function") {
      var stamp = row.occurred_at || row.started_at || row.created_at || null;
      key = stamp ? dayKeyOf(stamp) : null;
    }
    out.push(normalizeCandidate(row, { source: "window", day_key: key }));
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
function splitContrast(text) {
  var raw = String(text || "");
  var m = raw.match(CONTRAST);
  if (!m || m.index == null) {
    return { kind: "none", identify: raw, anti: "", identifyNumbers: numbersOf(raw) };
  }
  var positive = raw.slice(0, m.index);
  var negative = raw.slice(m.index + m[0].length);
  if (!contentTokens(negative).length) {
    // Correction: the number after "not" is the value being replaced, so it is
    // what points at the row. The number before it is the replacement.
    return { kind: "correction", identify: positive, anti: "", identifyNumbers: numbersOf(negative) };
  }
  return { kind: "selection", identify: positive, anti: negative, identifyNumbers: numbersOf(positive) };
}

function slotIn(text) {
  var t = String(text || "").toLowerCase();
  for (var i = 0; i < MEAL_SLOTS.length; i++) {
    if (new RegExp("\\b" + MEAL_SLOTS[i] + "\\b").test(t)) return MEAL_SLOTS[i];
  }
  return null;
}

// Is the whole reference just a pronoun, once the verb is stripped?
function isBarePronoun(ref) {
  var t = String(ref || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  // Strip a leading command verb ("delete that", "undo it", "remove that one").
  var stripped = t.replace(/^(please\s+)?(delete|remove|drop|undo|cancel|kill|scrap|bin)\s+/, "").trim();
  return PRONOUN_PHRASES.indexOf(stripped) >= 0;
}

function scoreCandidate(cand, parsed, refDayKey, refSlot) {
  var score = 0;
  var signals = [];
  var amountHits = 0;
  parsed.numbers.forEach(function (n) { if (cand.numbers.has(n)) amountHits += 1; });
  if (amountHits) { score += Math.min(amountHits, 2) * W_AMOUNT; signals.push("amount"); }

  var tokenHits = 0;
  parsed.tokens.forEach(function (t) { if (cand.tokens.has(t)) tokenHits += 1; });
  if (tokenHits) { score += Math.min(tokenHits, 8) * W_TOKEN; signals.push("token"); }

  var candDay = cand.day_key || (cand.occurred_at ? rrDayKey(cand.occurred_at) : "");
  if (refDayKey && candDay === refDayKey) { score += W_DAY; signals.push("day"); }
  if (refSlot && cand.slot === refSlot) { score += W_SLOT; signals.push("slot"); }

  var antiHits = 0;
  parsed.antiTokens.forEach(function (t) { if (cand.tokens.has(t)) antiHits += 1; });
  parsed.antiNumbers.forEach(function (n) { if (cand.numbers.has(n)) antiHits += 1; });
  if (antiHits) { score += antiHits * W_ANTI; signals.push("excluded"); }

  return { score: score, signals: signals };
}

function recencyOf(cand) {
  var t = new Date(cand.occurred_at || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function describeCandidate(cand) {
  var c = cand && cand.tokens ? cand : normalizeCandidate(cand || {});
  var when = c.occurred_at ? new Date(c.occurred_at).toISOString().slice(11, 16) : "";
  var label = c.text ? c.text.slice(0, 48) : (c.table || "row");
  return when ? label + " (" + when + ")" : label;
}

// Resolve a `target_ref` phrase against the closed world.
//
// options:
//   now         - ISO string; the day "today"/"same day" is measured against.
//   dayKey      - the caller's already-zone-resolved key for "today". Preferred
//                 over `now`, because only the caller knows the user's zone.
//   lastCapture - { rows: [...] } the IMMEDIATELY preceding capture in this
//                 session. A bare pronoun binds here and nowhere else, and only
//                 when that capture wrote exactly one row.
function resolveReferent(ref, candidates = null, options = null) {
  var opts = options || {};
  var all = candidates || [];
  var world = [];
  for (var i = 0; i < all.length; i++) {
    var c = all[i];
    if (c && c.id && CANDIDATE_SOURCES.indexOf(c.source) >= 0) world.push(c);
  }
  var text = String(ref || "").trim();
  if (!text) return { status: "not_found", reason: "empty_ref", candidates: [] };

  // --- pronouns -------------------------------------------------------------
  // "delete that". A pronoun has no content of its own, so the only honest
  // binding is the thing that was just said. Anything else - newest row in the
  // table, highest-scoring row in the world - is a guess wearing a rule.
  if (isBarePronoun(text)) {
    var priorRows = (opts.lastCapture && opts.lastCapture.rows) || [];
    var rows = [];
    for (var p = 0; p < priorRows.length; p++) if (priorRows[p]) rows.push(priorRows[p]);
    if (!rows.length) return { status: "not_found", reason: "no_preceding_capture", candidates: [] };
    if (rows.length > 1) {
      return {
        status: "ambiguous",
        reason: "preceding_capture_wrote_many",
        candidates: rows.slice(0, 3).map(function (r) { return r.tokens ? r : normalizeCandidate(r); }),
      };
    }
    var only = rows[0].tokens ? rows[0] : normalizeCandidate(rows[0]);
    return { status: "resolved", row: only.row || only, score: W_AMOUNT, via: "pronoun", candidate: only };
  }

  if (!world.length) return { status: "not_found", reason: "closed_world_empty", candidates: [] };

  var split = splitContrast(text);
  var parsed = {
    tokens: new Set(contentTokens(split.identify)),
    numbers: new Set(split.identifyNumbers),
    antiTokens: new Set(contentTokens(split.anti)),
    antiNumbers: new Set(numbersOf(split.anti)),
  };
  var refSlot = slotIn(split.identify);
  var todayKey = opts.dayKey || (opts.now ? rrDayKey(opts.now) : "");
  var refDayKey = /\btoday\b/i.test(text) && todayKey ? todayKey : "";

  if (!parsed.tokens.size && !parsed.numbers.size && !refSlot) {
    return { status: "not_found", reason: "no_identifying_terms", candidates: [] };
  }

  var scored = [];
  for (var w = 0; w < world.length; w++) {
    var s = scoreCandidate(world[w], parsed, refDayKey, refSlot);
    if (s.score > 0) scored.push({ cand: world[w], score: s.score, signals: s.signals });
  }
  // Recency is a TIEBREAK ORDER, never a score: it decides which of two equally
  // good matches is listed first in the ambiguity card, and nothing else.
  scored.sort(function (a, b) { return (b.score - a.score) || (recencyOf(b.cand) - recencyOf(a.cand)); });

  if (!scored.length) return { status: "not_found", reason: "no_match", candidates: [] };

  var top = scored[0];
  var second = scored[1];
  if (second && (top.score - second.score) / top.score < AMBIGUITY_MARGIN) {
    return {
      status: "ambiguous",
      reason: "within_margin",
      candidates: scored.slice(0, 3).map(function (x) { return x.cand; }),
      scores: scored.slice(0, 3).map(function (x) { return x.score; }),
    };
  }

  return { status: "resolved", row: top.cand.row || top.cand, score: top.score, via: top.signals.join("+"), candidate: top.cand };
}
// ==== REFERENT-RESOLVER MIRROR END ====

export {
  AMBIGUITY_MARGIN, MEAL_SLOTS, CANDIDATE_SOURCES, STOPWORDS, PRONOUN_PHRASES,
  tokensOf, contentTokens, numbersOf, rrDayKey,
  normalizeCandidate, buildClosedWorld, buildWindowWorld,
  splitContrast, isBarePronoun, describeCandidate, resolveReferent,
};

export default resolveReferent;
