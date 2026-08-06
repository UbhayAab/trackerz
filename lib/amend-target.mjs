// AMENDING A LOG THAT ALREADY EXISTS.
//
// "in the afternoon I said that I ate thirty grams of aloo bhujia, but then I
// remember later on that actually it was fifty grams. So I just type it in the
// text... update the thirty gram to fifty gram."
//
// Until this module the model could only INSERT. Every correction therefore
// became a SECOND row, and the day's totals counted the mistake and the fix. The
// two new tools (amend_log_candidate / delete_log_candidate) are the first ones
// that can destroy something already recorded, so everything here is built around
// one rule: THE MODEL NEVER NAMES A ROW ID. It emits the words the user said plus
// a date, and this module turns that into exactly one row, a question, or nothing.
//
// Three things are load-bearing and each of them is a way this goes wrong:
//
// 1. THE CANDIDATE WORLD IS CLOSED BY THE CALENDAR. The rows an amendment may
//    reach are the rows inside the window the user named, and nothing else. An
//    UNDATED amendment means TODAY - never "search wider until something
//    matches", because a widening search always finds something, and the row it
//    finds on the wrong day is a number nobody will think to re-check.
//
// 2. NO NEAREST NEIGHBOUR. Resolution is lib/referent-resolver.mjs, unchanged:
//    two candidates within AMBIGUITY_MARGIN (5%) is a question, zero matches is
//    not_found. This module adds the window; it does not add a tiebreak.
//
// 3. DATE RESOLUTION IS ZONE ARITHMETIC, NOT STRING SLICING. "yesterday" at
//    00:30 IST is 19:00 UTC the day before last. Every key here comes from
//    saDayKey (the mirrored twin of dayKeyInTz in lib/tz.mjs, which
//    tests/schedule-args.test.mjs proves agree across a year of instants).
//
// Pure: no DOM, no Supabase, no clock (every entry point takes `today`), no
// nutrition table (the caller injects `estimate`, so the server and the browser
// price an amended meal with their own copy of the SAME table). MIRRORED
// byte-identically into supabase/functions/agent/index.ts - run
// `node scripts/sync-mirror.mjs` after editing the block below.

// The zone helpers and the resolver are NOT duplicated here. lib/ imports them;
// the edge function's mirror block resolves to the edge's own copies of the same
// functions, which its SCHEDULE-ARGS and REFERENT-RESOLVER blocks already define.
import { saDayKey, saAddDays, saWeekdayOf, saMinuteOfDay, isDateKey, SA_DEFAULT_TZ } from "./schedule-args.mjs";
import { normalizeCandidate, buildWindowWorld, resolveReferent, AMBIGUITY_MARGIN } from "./referent-resolver.mjs";

// ==== AMEND-TARGET MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====

// ---------------------------------------------------------------------------
// 1. IS THIS AN AMENDMENT AT ALL?
// ---------------------------------------------------------------------------
//
// This is the question the whole feature hangs on, and getting it wrong in the
// permissive direction is far worse than not having the feature: a capture read
// as an amendment when it was a new meal is a meal that never gets logged. So
// the test is deliberately structural rather than a bag of keywords.
//
// An amendment is one of:
//   (a) a DELETION verb aimed at something definite ("delete the coke I logged"),
//   (b) a NUMERIC CONTRAST - two figures either side of "not" / "instead of"
//       ("60 minutes not 40", "50g ... not 30g"). Nobody writes that shape about
//       a thing that has not been recorded yet.
//   (c) a CORRECTION OPENER or an EDIT VERB *plus* something that says WHICH
//       record ("actually", "change", "update" + "yesterday's dinner" / "the gym
//       session" / "I logged"). The opener alone is not enough: "actually I had
//       6 eggs" is a plain log with a filler word in front of it.

var AMEND_DELETE_VERB = /\b(delete|remove|drop|erase|scratch|get rid of|take off|undo|cancel)\b/i;
// A deletion needs a definite object. "delete" with nothing after it is not an
// instruction about a row, and "remove sugar from my diet" is not either.
var AMEND_DEFINITE = /\b(the|that|this|those|it|my|today'?s|yesterday'?s|last night'?s|logged)\b/i;

// Two numbers with a contrast marker between them. The span limits keep it inside
// one clause: "spent 250 on lunch, not the 400 I planned last month" is a stretch
// already, and anything looser starts matching ordinary prose.
var AMEND_NUMERIC_CONTRAST = /\d[^.;!?]{0,40}?\b(?:not|instead of|rather than|and not|nahi)\b[^.;!?]{0,14}?\d/i;

var AMEND_OPENER = /\b(actually|correction|i meant|i mean|scratch that|my (?:bad|mistake)|to correct|correcting|sorry,? it|sorry,? i)\b/i;
var AMEND_EDIT_VERB = /\b(change|update|edit|correct|fix|amend|revise|make it|set it to|should (?:be|have been)|was actually|it was)\b/i;
// Something that names an EXISTING record rather than an event.
var AMEND_TARGET_NOUN = /\b(?:the|that|my|yesterday'?s|today'?s|monday'?s|tuesday'?s|wednesday'?s|thursday'?s|friday'?s|saturday'?s|sunday'?s|this morning'?s|last night'?s)\s+(?:\w+\s+){0,2}(log|logs|entry|entries|row|meal|breakfast|lunch|dinner|snack|workout|session|gym|run|walk|expense|spend|spending|payment|note|water|sleep|weight)\b/i;
var AMEND_LOGGED_WORD = /\b(i logged|logged (?:it|that|this|earlier|today|yesterday)|already logged it as|the log|the entry)\b/i;

/** A deletion instruction aimed at a definite, already-recorded thing. */
function looksLikeDeletion(text) {
  var t = String(text || "");
  if (!t.trim()) return false;
  return AMEND_DELETE_VERB.test(t) && AMEND_DEFINITE.test(t);
}

/** Does this capture CORRECT or REMOVE something already logged? */
function looksLikeAmendment(text) {
  var t = String(text || "");
  if (!t.trim()) return false;
  if (looksLikeDeletion(t)) return true;
  if (AMEND_NUMERIC_CONTRAST.test(t)) return true;
  if (!AMEND_OPENER.test(t) && !AMEND_EDIT_VERB.test(t)) return false;
  return AMEND_TARGET_NOUN.test(t) || AMEND_LOGGED_WORD.test(t);
}

// What the grounding gate asks of these two tools. A hallucinated amendment
// rewrites a figure the user is relying on, so the EVIDENCE has to carry the act
// of correcting - not merely the words of the new value.
var AMEND_CUE = new RegExp(
  "(" + AMEND_DELETE_VERB.source + ")|(" + AMEND_NUMERIC_CONTRAST.source + ")|(" + AMEND_OPENER.source + ")|(" + AMEND_EDIT_VERB.source + ")",
  "i",
);
var DELETE_CUE = AMEND_DELETE_VERB;

// ---------------------------------------------------------------------------
// 2. WHICH TABLE, WHICH COLUMNS
// ---------------------------------------------------------------------------
//
// The closed set. An amendment may only ever write a column named here: not
// `user_id` (which would move the row to another account), not `id`, not
// `deleted_at` (a delete is its own op with its own budget), not `ingestion_id`
// (provenance is a fact about where the row came from, and an edit does not
// change that).

var AMEND_KINDS = ["food", "money", "workout", "water", "sleep", "body", "wellness", "note"];

var AMEND_TABLE_FOR_KIND = {
  food: "food_logs",
  money: "ledger_entries",
  workout: "workout_logs",
  water: "hydration_logs",
  sleep: "sleep_sessions",
  body: "body_metrics",
  wellness: "wellness_logs",
  note: "notes",
};

var AMEND_KIND_FOR_TABLE = {
  food_logs: "food",
  ledger_entries: "money",
  workout_logs: "workout",
  hydration_logs: "water",
  sleep_sessions: "sleep",
  body_metrics: "body",
  wellness_logs: "wellness",
  notes: "note",
};

// column -> how to coerce and bound it. `num` keeps a finite number inside
// [lo, hi] or REJECTS it (never clamps: a clamped 50,000-calorie meal is a
// 6,000-calorie meal nobody asked for). `int` rounds first.
var AMENDABLE_COLUMNS = {
  food: {
    description: { t: "str", max: 500 },
    meal_name: { t: "str", max: 200 },
    meal_slot: { t: "enum", of: ["breakfast", "lunch", "snack", "dinner", "other"] },
    calories_estimate: { t: "int", lo: 0, hi: 20000 },
    protein_g: { t: "num", lo: 0, hi: 1000 },
    carbs_g: { t: "num", lo: 0, hi: 2000 },
    fat_g: { t: "num", lo: 0, hi: 1000 },
    occurred_at: { t: "iso" },
  },
  money: {
    amount: { t: "num", lo: 0.01, hi: 5000000 },
    merchant: { t: "str", max: 200 },
    description: { t: "str", max: 500 },
    payment_mode: { t: "enum", of: ["upi", "card", "cash", "netbanking", "wallet", "transfer", "other"] },
    is_discretionary: { t: "bool" },
    occurred_at: { t: "iso" },
  },
  workout: {
    description: { t: "str", max: 500 },
    duration_min: { t: "num", lo: 0, hi: 600 },
    intensity: { t: "str", max: 40 },
    status: { t: "enum", of: ["done", "skipped", "rest"] },
    occurred_at: { t: "iso" },
  },
  water: {
    ml: { t: "int", lo: 1, hi: 15000 },
    occurred_at: { t: "iso" },
  },
  sleep: {
    started_at: { t: "iso" },
    ended_at: { t: "iso" },
    quality: { t: "int", lo: 1, hi: 5 },
    note: { t: "str", max: 500 },
  },
  body: {
    metric_type: { t: "enum", of: ["weight", "sleep_hours", "steps", "water_ml"] },
    value: { t: "num", lo: 0, hi: 1000000 },
    unit: { t: "str", max: 20 },
    occurred_at: { t: "iso" },
  },
  wellness: {
    note: { t: "str", max: 1000 },
    mood_score: { t: "int", lo: 1, hi: 10 },
    energy_score: { t: "int", lo: 1, hi: 10 },
    stress_score: { t: "int", lo: 1, hi: 10 },
    occurred_at: { t: "iso" },
  },
  note: {
    body: { t: "str", max: 2000 },
    kind: { t: "enum", of: ["note", "aspiration", "todo", "idea"] },
    domain: { t: "enum", of: ["money", "diet", "gym", "wellness", "general"] },
    status: { t: "enum", of: ["open", "done", "archived"] },
    due_on: { t: "day" },
    occurred_at: { t: "iso" },
  },
};

// The figure each kind's diff card has to LEAD with - the one the decision
// actually turns on. A food amendment is about calories and protein; the meal
// name is supporting evidence for that sentence.
var AMEND_HEADLINE = {
  food: ["calories_estimate", "protein_g"],
  money: ["amount"],
  workout: ["duration_min", "status"],
  water: ["ml"],
  sleep: ["quality"],
  body: ["value"],
  wellness: ["mood_score"],
  note: ["status"],
};

// The columns that make a row recognisable in a chooser button. Never the whole
// row: three buttons on a phone have room for a phrase and a time.
var AMEND_LABEL_COLUMNS = ["description", "meal_name", "merchant", "note", "body", "title"];

function amendKindOf(v) {
  var s = String(v == null ? "" : v).trim().toLowerCase();
  if (AMEND_TABLE_FOR_KIND[s]) return s;
  if (AMEND_KIND_FOR_TABLE[s]) return AMEND_KIND_FOR_TABLE[s];
  // Everyday synonyms the model reaches for. Deliberately short: an unrecognised
  // kind is null, and a null kind is a not_found, not a guess at food.
  if (s === "diet" || s === "meal" || s === "foods") return "food";
  if (s === "expense" || s === "spend" || s === "spending" || s === "ledger") return "money";
  if (s === "gym" || s === "exercise" || s === "fitness" || s === "workouts") return "workout";
  if (s === "hydration" || s === "drink") return "water";
  if (s === "notes") return "note";
  if (s === "metric" || s === "weight" || s === "steps") return "body";
  return null;
}

function amendTableFor(kind) {
  var k = amendKindOf(kind);
  return k ? AMEND_TABLE_FOR_KIND[k] : null;
}

// ---------------------------------------------------------------------------
// 3. THE DATE WINDOW
// ---------------------------------------------------------------------------

var AMEND_WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
var AMEND_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// A window may never be wider than this. "last month" is not a thing an
// amendment gets to mean: the wider the window, the more certain it is that
// SOMETHING in it matches, and a confident match on the wrong day is the exact
// failure this module exists to prevent.
var AMEND_WINDOW_MAX_DAYS = 31;

function amendWindow(fromKey, toKey, label, via) {
  return { fromKey: fromKey, toKey: toKey, label: label, via: via, explicit: via !== "default_today" };
}

/** The most recent day at or before `today` whose weekday is `wd`. */
function amendLastWeekday(today, wd, strictlyBefore) {
  var start = strictlyBefore ? 1 : 0;
  for (var i = start; i < 8; i++) {
    var key = saAddDays(today, -i);
    if (saWeekdayOf(key) === wd) return key;
  }
  return today;
}

/** The most recent day at or before `today` whose day-of-month is `dom`. */
function amendLastDayOfMonth(today, dom) {
  for (var i = 0; i < 62; i++) {
    var key = saAddDays(today, -i);
    if (Number(key.slice(8, 10)) === dom) return key;
  }
  return null;
}

function amendPad(n) {
  return String(n).padStart(2, "0");
}

/** A day/month pair as the most recent such date at or before `today`. */
function amendDayMonth(today, day, month) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  var year = Number(today.slice(0, 4));
  var key = year + "-" + amendPad(month) + "-" + amendPad(day);
  if (!isDateKey(key)) return null;
  // A date later in the calendar than today means the user meant last year -
  // "2 Aug" said in January is seven months ago, not five months from now. An
  // amendment can only ever be about the past.
  if (key > today) {
    key = (year - 1) + "-" + amendPad(month) + "-" + amendPad(day);
    if (!isDateKey(key)) return null;
  }
  return key;
}

/**
 * Turn the words a person uses for a day into a window of day keys.
 *
 * `today` is ALREADY the user's local day key - resolved by the caller through
 * saDayKey/dayKeyInTz. Nothing in here reads a clock or a zone, so the same
 * phrase always produces the same window for the same day.
 *
 * Returns null when the phrase names no day at all, which is different from
 * naming today: the caller decides what an undated amendment means (it means
 * today, and only today).
 */
function parseWhenPhrase(phrase, today) {
  var t = String(phrase || "").toLowerCase();
  if (!t.trim() || !isDateKey(today)) return null;

  // -- an explicit calendar date --------------------------------------------
  var iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && isDateKey(iso[1])) return amendWindow(iso[1], iso[1], iso[1], "iso_date");

  // dd/mm[/yyyy]. India writes the day first, and this app is INR/IST - the
  // convention is decided once, here, rather than guessed per string.
  //
  // SLASHES ONLY for the year-less form, and a hyphen form must carry its year.
  // Accepting `\d{1,2}-\d{1,2}` would read "3-4 rotis" as the 3rd of April and
  // "200-300 g curd" as a date, which is a whole capture amended onto a day
  // nobody named.
  var dmy = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/) || t.match(/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/);
  if (dmy) {
    var dd = Number(dmy[1]);
    var mm = Number(dmy[2]);
    var yy = dmy[3] ? Number(dmy[3].length === 2 ? "20" + dmy[3] : dmy[3]) : null;
    if (yy) {
      var exact = yy + "-" + amendPad(mm) + "-" + amendPad(dd);
      if (isDateKey(exact)) return amendWindow(exact, exact, exact, "dmy");
    } else {
      var back = amendDayMonth(today, dd, mm);
      if (back) return amendWindow(back, back, back, "dmy");
    }
  }

  // -- relative days ---------------------------------------------------------
  // Longest form first: "the day before yesterday" contains "yesterday".
  if (/\b(day before yesterday|din before yesterday)\b/.test(t)) {
    var d2 = saAddDays(today, -2);
    return amendWindow(d2, d2, "the day before yesterday", "relative");
  }
  if (/\b(yesterday|last night|kal raat|yday)\b/.test(t)) {
    var d1 = saAddDays(today, -1);
    return amendWindow(d1, d1, "yesterday", "relative");
  }
  if (/\b(today|this morning|this afternoon|this evening|tonight|just now|earlier today|a while ago|aaj)\b/.test(t)) {
    return amendWindow(today, today, "today", "relative");
  }
  var ago = t.match(/\b(\d{1,2})\s*(?:days?|din)\s*(?:ago|back|before)\b/);
  if (ago) {
    var n = Number(ago[1]);
    if (n >= 1 && n <= AMEND_WINDOW_MAX_DAYS) {
      var dn = saAddDays(today, -n);
      return amendWindow(dn, dn, n + " days ago", "relative");
    }
  }

  // -- ranges ----------------------------------------------------------------
  if (/\b(last week|past week|previous week|this week|past 7 days|last 7 days)\b/.test(t)) {
    var from = saAddDays(today, -6);
    return amendWindow(from, today, "the last 7 days", "range");
  }

  // -- a named weekday -------------------------------------------------------
  // "last Tuesday" is strictly before today, so said ON a Tuesday it means the
  // Tuesday a week ago. "on Tuesday" is at-or-before, so said on a Tuesday it
  // means today - which is what a person means.
  //
  // The three-letter abbreviation is only honoured after a modifier ("on sat",
  // "last tue"). A bare `sat` matches "I sat down" and `sun` matches nothing the
  // user meant, and an amendment silently retargeted onto last Saturday is the
  // worst possible outcome of a spelling coincidence.
  for (var w = 0; w < AMEND_WEEKDAY_NAMES.length; w++) {
    var name = AMEND_WEEKDAY_NAMES[w];
    var short3 = name.slice(0, 3);
    var withMod = t.match(new RegExp("\\b(last|this|on|past)\\s+(?:" + name + "|" + short3 + ")\\b"));
    var bare = withMod ? null : t.match(new RegExp("\\b" + name + "\\b"));
    if (!withMod && !bare) continue;
    var strict = withMod ? /^(last|past)$/.test(withMod[1]) : false;
    var key = amendLastWeekday(today, w, strict);
    return amendWindow(key, key, (strict ? "last " : "") + name, "weekday");
  }

  // -- a month name with a day ("2 Aug", "Aug 2", "2nd August") --------------
  for (var mi = 0; mi < AMEND_MONTH_NAMES.length; mi++) {
    var mon = AMEND_MONTH_NAMES[mi];
    var monRx = new RegExp("\\b(" + mon + "|" + mon.slice(0, 3) + ")\\b");
    if (!monRx.test(t)) continue;
    var before = t.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:" + mon + "|" + mon.slice(0, 3) + ")\\b"));
    var after = t.match(new RegExp("\\b(?:" + mon + "|" + mon.slice(0, 3) + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b"));
    var dayNum = before ? Number(before[1]) : (after ? Number(after[1]) : null);
    if (dayNum == null) continue;
    var monthKey = amendDayMonth(today, dayNum, mi + 1);
    if (monthKey) return amendWindow(monthKey, monthKey, dayNum + " " + mon, "month_day");
  }

  // -- a bare ordinal day-of-month ("on the 3rd") ----------------------------
  var ord = t.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/) || t.match(/\bon\s+the\s+(\d{1,2})\b/);
  if (ord) {
    var dom = Number(ord[1]);
    var domKey = dom >= 1 && dom <= 31 ? amendLastDayOfMonth(today, dom) : null;
    if (domKey) return amendWindow(domKey, domKey, "the " + dom + "th", "day_of_month");
  }

  return null;
}

/**
 * The window an amendment may search, from whatever the model gave us.
 *
 * Priority: an explicit range, then an explicit date, then the words the user
 * used, then TODAY. That last fallback is the whole safety story: an undated
 * amendment can only ever touch today, and it can NEVER quietly reach back into
 * last week because nothing matched.
 *
 * opts: { today, tz, now } - `today` wins; otherwise it is derived from `now` in
 * `tz`, which is the only clock read in this file and it is injected.
 */
function resolveAmendWindow(args, opts) {
  var a = args || {};
  var o = opts || {};
  var tz = o.tz || SA_DEFAULT_TZ;
  var today = isDateKey(o.today) ? o.today : (o.now ? saDayKey(o.now, tz) : null);
  if (!isDateKey(today)) return { fromKey: null, toKey: null, label: "", via: "no_today", explicit: false, error: "no_today" };

  var from = isDateKey(a.date_from) ? a.date_from : null;
  var to = isDateKey(a.date_to) ? a.date_to : null;
  if (from && to) {
    if (from > to) { var swap = from; from = to; to = swap; }
    var span = amendSpanDays(from, to);
    if (span > AMEND_WINDOW_MAX_DAYS) {
      return { fromKey: null, toKey: null, label: "", via: "range", explicit: true, error: "window_too_wide" };
    }
    return amendWindow(from, to, from + " to " + to, "range");
  }
  if (isDateKey(a.on_date)) return amendWindow(a.on_date, a.on_date, a.on_date, "on_date");

  var parsed = parseWhenPhrase(a.when, today) || parseWhenPhrase(a.target_ref, today) || parseWhenPhrase(o.text, today);
  if (parsed) return parsed;

  // UNDATED. Today, and only today.
  return amendWindow(today, today, "today", "default_today");
}

/** Whole days between two keys, inclusive of both ends. */
function amendSpanDays(fromKey, toKey) {
  var n = 0;
  var cursor = fromKey;
  while (cursor <= toKey && n <= AMEND_WINDOW_MAX_DAYS + 1) {
    n += 1;
    cursor = saAddDays(cursor, 1);
  }
  return n;
}

/** Is this row's local day inside the window? */
function amendInWindow(dayKey, window) {
  if (!dayKey || !window || !window.fromKey || !window.toKey) return false;
  return dayKey >= window.fromKey && dayKey <= window.toKey;
}

// ---------------------------------------------------------------------------
// 4. RESOLVING THE TARGET
// ---------------------------------------------------------------------------

/**
 * Resolve `target_ref` to exactly one row inside the window, or to a question.
 *
 * `rows` are the rows the caller loaded for the window - already scoped to the
 * user and already excluding tombstones. Rows outside the window are dropped
 * HERE as well as in the query, because a closed world that depends on the
 * caller having filtered correctly is not closed.
 *
 * @returns {{status: "resolved"|"ambiguous"|"not_found", row?, candidates, window, reason}}
 */
function resolveAmendTarget(input) {
  var i = input || {};
  var tz = i.tz || SA_DEFAULT_TZ;
  var window = i.window;
  if (!window || window.error || !window.fromKey) {
    return { status: "not_found", reason: window && window.error ? window.error : "no_window", candidates: [], window: window || null };
  }
  var dayKeyOf = function (stamp) { return saDayKey(stamp, tz); };
  var world = buildWindowWorld(i.rows || [], dayKeyOf).filter(function (c) {
    return amendInWindow(c.day_key, window);
  });
  if (!world.length) {
    return { status: "not_found", reason: "no_rows_in_window", candidates: [], window: window };
  }
  var out = resolveReferent(i.targetRef, world, {
    dayKey: i.today || null,
    lastCapture: i.lastCapture || null,
  });
  return {
    status: out.status,
    row: out.row || null,
    candidate: out.candidate || null,
    candidates: out.candidates || [],
    scores: out.scores || null,
    via: out.via || null,
    reason: out.reason || null,
    window: window,
  };
}

/**
 * One chooser button's worth of a row: "50g aloo bhujia, 15:14 today".
 *
 * Named at most three times on a phone, so it has to be the phrase plus the one
 * thing that tells two of them apart - the clock, in the user's zone.
 */
function describeAmendCandidate(cand, opts) {
  var o = opts || {};
  var tz = o.tz || SA_DEFAULT_TZ;
  var c = cand && cand.tokens ? cand : normalizeCandidate(cand || {});
  var label = "";
  var row = c.row || {};
  for (var i = 0; i < AMEND_LABEL_COLUMNS.length; i++) {
    var v = row[AMEND_LABEL_COLUMNS[i]];
    if (typeof v === "string" && v.trim()) { label = v.trim(); break; }
  }
  if (!label) label = c.text || (c.table || "row");
  if (label.length > 40) label = label.slice(0, 39) + "…";
  var stamp = c.occurred_at;
  if (!stamp) return label;
  var mins = saMinuteOfDay(stamp, tz);
  var clock = String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  var key = c.day_key || saDayKey(stamp, tz);
  var when = key;
  if (o.today) {
    if (key === o.today) when = "today";
    else if (key === saAddDays(o.today, -1)) when = "yesterday";
    else when = AMEND_WEEKDAY_NAMES[saWeekdayOf(key)] + " " + key.slice(5);
  }
  return label + ", " + clock + " " + when;
}

// ---------------------------------------------------------------------------
// 5. THE WRITE PLAN
// ---------------------------------------------------------------------------
//
// ONE function produces the plan that is PREVIEWED in the diff card and the plan
// that is EXECUTED on confirm. Nothing downstream recomputes a value; the
// executor reads `values` and writes them. That is the same discipline
// ingestStatements() enforces for bank imports, and it is why the card cannot
// promise a number the write will not make.

function amendIsBlank(v) {
  return v === undefined || v === null || v === "";
}

/** Coerce one value against its column rule, or return undefined to reject it. */
function amendCoerce(rule, value) {
  if (!rule || amendIsBlank(value)) return undefined;
  if (rule.t === "str") {
    if (typeof value !== "string") return undefined;
    var s = value.trim();
    return s ? s.slice(0, rule.max || 500) : undefined;
  }
  if (rule.t === "enum") {
    var e = String(value).trim().toLowerCase();
    return rule.of.indexOf(e) >= 0 ? e : undefined;
  }
  if (rule.t === "bool") {
    if (typeof value === "boolean") return value;
    var b = String(value).trim().toLowerCase();
    if (b === "true" || b === "yes") return true;
    if (b === "false" || b === "no") return false;
    return undefined;
  }
  if (rule.t === "num" || rule.t === "int") {
    var n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(n)) return undefined;
    if (rule.t === "int") n = Math.round(n);
    if (rule.lo !== undefined && n < rule.lo) return undefined;
    if (rule.hi !== undefined && n > rule.hi) return undefined;
    return n;
  }
  if (rule.t === "iso") {
    if (typeof value !== "string") return undefined;
    var ms = Date.parse(value);
    return Number.isFinite(ms) ? value : undefined;
  }
  if (rule.t === "day") {
    return isDateKey(value) ? String(value) : undefined;
  }
  return undefined;
}

/**
 * The columns an amendment asked for, filtered to the ones it is allowed to
 * write and coerced to the shapes the database accepts.
 *
 * `dropped` is returned rather than swallowed. A silently discarded field is
 * this codebase's signature failure - the user says "make it 50 g and move it to
 * dinner", one of the two lands, and nothing anywhere says which.
 */
function amendValues(kind, set) {
  var k = amendKindOf(kind);
  var rules = k ? AMENDABLE_COLUMNS[k] : null;
  var values = {};
  var dropped = [];
  if (!rules) return { values: values, dropped: dropped, error: "unknown_kind" };
  var input = set && typeof set === "object" && !Array.isArray(set) ? set : {};
  var keys = Object.keys(input);
  for (var i = 0; i < keys.length; i++) {
    var col = keys[i];
    if (col.charAt(0) === "_") continue; // pipeline metadata, never a column
    if (!rules[col]) { dropped.push(col + ":not_amendable"); continue; }
    var coerced = amendCoerce(rules[col], input[col]);
    if (coerced === undefined) { dropped.push(col + ":bad_value"); continue; }
    values[col] = coerced;
  }
  return { values: values, dropped: dropped, error: null };
}

/** Loose equality that treats "7.00" (numeric out of postgres) as 7. */
function amendSameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  var na = typeof a === "number" ? a : Number(a);
  var nb = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na === nb;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return false;
}

function amendPick(source, columns) {
  var out = {};
  for (var i = 0; i < columns.length; i++) {
    var c = columns[i];
    out[c] = source && c in source ? source[c] : null;
  }
  return out;
}

/**
 * The single write that carries out this tool call against this row.
 *
 * @param {{name, args, row, estimate}} input
 *   `estimate` is the nutrition table, injected. When an amended food
 *   description is fully recognised the table's totals OVERRIDE whatever the
 *   model put in `set` - the same authority order an INSERT already uses, so a
 *   corrected meal is priced exactly as it would have been had the user typed it
 *   right the first time.
 * @returns {{op, table, id, kind, before, values, columns, headline, dropped, reason}}
 */
function amendWritePlan(input) {
  var i = input || {};
  var args = i.args || {};
  var row = i.row || null;
  var kind = amendKindOf(args.target_kind) || (row && row.table ? amendKindOf(row.table) : null);
  var table = amendTableFor(kind);
  if (!row || !row.id) return { op: "none", reason: "no_target_row", table: table, id: null, kind: kind, values: {}, columns: [], dropped: [] };
  if (!table) return { op: "none", reason: "unknown_kind", table: null, id: row.id, kind: null, values: {}, columns: [], dropped: [] };

  if (i.name === "delete_log_candidate") {
    // A DELETE is a tombstone and nothing else. `deleted_at` is stamped by the
    // executor, not here: a pure module must not read a clock, and the timestamp
    // that matters is the one at write time.
    return {
      op: "soft_delete",
      table: table, id: row.id, kind: kind,
      before: amendPick(row, ["deleted_at"]),
      values: {}, columns: ["deleted_at"],
      headline: amendHeadlineOf(kind, row, row),
      dropped: [], reason: null,
    };
  }

  var built = amendValues(kind, args.set);
  var values = built.values;

  // The deterministic table beats the model for everyday foods, on an amendment
  // exactly as on an insert. (Bracket access on purpose: this block is mirrored
  // verbatim into a .ts file where `values` is an open bag of columns, and dot
  // access there is a compile error rather than a fact about the code.)
  if (kind === "food" && typeof i.estimate === "function" && typeof values["description"] === "string") {
    var est = i.estimate(values["description"]);
    if (est && est.recognized && est.totals) {
      values["calories_estimate"] = est.totals.calories;
      values["protein_g"] = est.totals.protein_g;
      values["carbs_g"] = est.totals.carbs_g;
      values["fat_g"] = est.totals.fat_g;
    }
  }

  // Drop the no-ops. "Change it to 50 g" when it already says 50 g is not a
  // write, and recording it as one would put a meaningless entry in the audit
  // log and an empty diff card in front of the user.
  var columns = [];
  var keys = Object.keys(values);
  for (var k = 0; k < keys.length; k++) {
    if (amendSameValue(row[keys[k]], values[keys[k]])) { delete values[keys[k]]; continue; }
    columns.push(keys[k]);
  }
  if (!columns.length) {
    return { op: "none", reason: built.error || "no_change", table: table, id: row.id, kind: kind, values: {}, columns: [], dropped: built.dropped };
  }

  var after = {};
  for (var c = 0; c < columns.length; c++) after[columns[c]] = values[columns[c]];
  return {
    op: "update",
    table: table, id: row.id, kind: kind,
    before: amendPick(row, columns),
    values: values,
    columns: columns,
    headline: amendHeadlineOf(kind, row, Object.assign({}, row, after)),
    dropped: built.dropped,
    reason: null,
  };
}

/** The one or two figures the diff card leads with, before and after. */
function amendHeadlineOf(kind, before, after) {
  var cols = AMEND_HEADLINE[amendKindOf(kind)] || [];
  var out = [];
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i];
    var b = before ? before[col] : null;
    var a = after ? after[col] : null;
    if (amendIsBlank(b) && amendIsBlank(a)) continue;
    out.push({ column: col, from: b == null ? null : b, to: a == null ? null : a, changed: !amendSameValue(b, a) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. THE DELETE BUDGET
// ---------------------------------------------------------------------------
//
// A model that has learned to delete can delete a lot in one capture, and a
// prompt-injected one can try to delete everything. Neither is stopped by a
// confirm gate alone, because a user tapping through a list of confirmations is
// a user who stops reading them. The budget is the backstop that does not depend
// on attention: after MAX_DELETES_PER_DAY tombstones in a rolling day, the tool
// stops being available and says so.
//
// Counted from the AUDIT LOG, which is append-only and which no tool can erase -
// counting ai_actions would let a delete of the audit trail raise the ceiling.
var MAX_DELETES_PER_DAY = 10;

function deleteBudget(usedToday, max) {
  var cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_DELETES_PER_DAY;
  var raw = Number(usedToday);
  // A count that is not a finite number means the counter could not be READ -
  // the edge returns Infinity when the query errors. That is not zero, it is
  // unknown, and unknown fails CLOSED: a budget that stops being enforced the
  // moment its own lookup breaks is not a budget.
  if (!Number.isFinite(raw)) return { allowed: false, used: cap, remaining: 0, max: cap, unknown: true };
  var used = Math.max(0, Math.floor(raw));
  var remaining = Math.max(0, cap - used);
  return { allowed: remaining > 0, used: used, remaining: remaining, max: cap };
}
// ==== AMEND-TARGET MIRROR END ====

export {
  AMEND_CUE, DELETE_CUE, AMEND_KINDS, AMEND_TABLE_FOR_KIND, AMEND_KIND_FOR_TABLE,
  AMENDABLE_COLUMNS, AMEND_HEADLINE, AMEND_WINDOW_MAX_DAYS, MAX_DELETES_PER_DAY,
  looksLikeAmendment, looksLikeDeletion,
  amendKindOf, amendTableFor, amendValues, amendSameValue,
  parseWhenPhrase, resolveAmendWindow, amendInWindow, amendSpanDays,
  resolveAmendTarget, describeAmendCandidate, amendWritePlan, amendHeadlineOf,
  deleteBudget, AMBIGUITY_MARGIN,
};

export default resolveAmendTarget;
