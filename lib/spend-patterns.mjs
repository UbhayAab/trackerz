// Recurring-spend pattern learning - "you have paid Rs 110 for this same lunch
// four times". Pure (no DOM, no Supabase) so it is testable in isolation and
// mirrorable into the Deno agent function, which cannot import repo lib/.
// The block between the MIRROR markers is copied verbatim into
// supabase/functions/agent/index.ts; scripts/sync-mirror.mjs is the tool that
// keeps such blocks in step (its BLOCKS list currently covers the jarvis
// mirrors - add this pair there when wiring it up).
//
// The rule this module exists to respect: a suggested amount is a CLAIM about
// money the user did NOT state in this capture. It may only ever be handed back
// with the evidence that earned it (how many times, across what dates, how
// recently) and it must NEVER become a row on its own. Below the support floor
// we return null - never a softer guess, never a rounded average nobody paid.
//
// Timezone math uses Intl only (Asia/Kolkata has no DST; handled generally anyway).

import { extractAmount } from "./fan-out-expander.mjs";

// ==== SPEND-PATTERNS MIRROR START (byte-identical in supabase/functions/agent/index.ts) ====

// Three is the floor, not a tunable: two matching lunches is a coincidence and
// the whole point of this module is that confidence has to be earned.
var SP_MIN_SUPPORT = 3;
// Dice overlap of significant tokens. 0.4 is what makes "egg curry roti with 3
// eggs" / "2 rotis and 3 eggs" / "rice and 3 eggs" one cluster while keeping
// "coffee and cookies" out of it.
var SP_SIM_MIN = 0.4;
var SP_AMOUNT_ABS_TOL = 10;      // Rs - small absolute wobble is the same meal
var SP_AMOUNT_REL_TOL = 0.25;    // …and so is a quarter either side on bigger tickets
var SP_TIME_TOL_MIN = 150;       // "around midday" is +/- 2.5h, not +/- 5 min
var SP_PAIR_WINDOW_MIN = 90;     // a food log and the expense from the SAME capture
var SP_STALE_DAYS = 45;          // a price from two months ago is not today's price
var SP_MIN_SUGGEST_CONFIDENCE = 0.45;
var SP_DEFAULT_TZ = "Asia/Kolkata";

// Words that carry no dish identity: logging verbs, meal slots, money words,
// portions, filler. Dropping them is what lets three differently-worded captures
// of the same meal share a signature. Dish adjectives ("curry", "masala") are
// deliberately NOT here - they discriminate between meals.
var SP_STOPWORDS = new Set([
  "ate", "eat", "eaten", "eating", "had", "have", "having", "drank", "drink",
  "drinking", "consumed", "took", "take", "just", "today", "yesterday", "now",
  "and", "with", "plus", "the", "some", "for", "my", "me", "this", "that",
  "these", "those", "was", "were", "is", "are", "from", "got", "sent", "free",
  "morning", "afternoon", "evening", "night", "tonight", "breakfast", "lunch",
  "dinner", "snack", "brunch", "supper", "meal", "food", "paid", "pay", "paying",
  "spent", "spend", "spending", "bought", "buy", "buying", "cost", "costs",
  "costed", "price", "rupee", "rupees", "inr", "only", "also", "approx", "about",
  "around", "roughly", "plate", "bowl", "cup", "glass", "katori", "piece",
  "pieces", "serving", "servings", "portion", "small", "big", "large", "medium",
  "regular", "extra", "more", "less", "little", "home", "homemade", "made",
  "make", "plain", "hot", "cold", "fresh", "order", "ordered", "auto", "gram",
  "grams", "half", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "there", "here", "again", "usual", "same",
]);

function spClamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : (n > hi ? hi : n);
}

function spRound2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// "110" not "110.00"; a paise-level amount keeps its paise.
function spMoney(n) {
  var v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// Crude singular so "rotis"/"eggs" share a token with "roti"/"egg". Guarded on
// length and on "ss" so "glass" does not become "glas".
function spSingular(word) {
  if (word.length >= 4 && word.charAt(word.length - 1) === "s" && word.slice(-2) !== "ss") {
    return word.slice(0, -1);
  }
  return word;
}

// The description signature: the set of dish-bearing tokens. Digits are dropped
// on purpose - "3 eggs" and "2 eggs" are the same meal, and the quantity noise
// is exactly what stops exact-match clustering from ever working.
function spTokens(text) {
  var words = String(text == null ? "" : text)
    .toLowerCase()
    .replace(/\(auto from spend\)/g, " ")
    .replace(/[^a-z]+/g, " ")
    .split(/\s+/);
  var out = new Set();
  for (var i = 0; i < words.length; i++) {
    var w = spSingular(words[i]);
    if (w.length < 3) continue;
    if (SP_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

// Dice coefficient: 2|A∩B| / (|A|+|B|). Symmetric, and unlike a raw overlap
// coefficient a one-token description cannot swallow a five-token one.
function spDice(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  var inter = 0;
  a.forEach(function (t) { if (b.has(t)) inter += 1; });
  if (inter === 0) return 0;
  return (2 * inter) / (a.size + b.size);
}

function spIntersect(a, b) {
  var out = [];
  a.forEach(function (t) { if (b.has(t)) out.push(t); });
  return out;
}

// ---- time helpers ----

function spInstant(value, what) {
  var ms = value instanceof Date ? value.getTime() : Date.parse(String(value == null ? "" : value));
  if (!Number.isFinite(ms)) throw new TypeError("spend-patterns: unparseable timestamp for " + what + ": " + String(value));
  return ms;
}

function spMinuteOfDayInTz(ms, timeZone) {
  var parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ms));
  var h = 0, m = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === "hour") h = Number(parts[i].value);
    if (parts[i].type === "minute") m = Number(parts[i].value);
  }
  if (h === 24) h = 0; // some locales render midnight as hour 24
  return h * 60 + m;
}

function spDateKeyInTz(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

function spDayDiff(fromKey, toKey) {
  var a = Date.parse(fromKey + "T00:00:00Z");
  var b = Date.parse(toKey + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Shortest distance between two minutes-of-day, wrapping midnight: 23:50 and
// 00:10 are 20 minutes apart, not 1420.
function spCircularDelta(a, b) {
  var d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

function spSignedCircularDelta(minute, anchor) {
  var d = ((minute - anchor) % 1440 + 1440) % 1440;
  return d > 720 ? d - 1440 : d;
}

function spMedian(values) {
  if (!values.length) return 0;
  var s = values.slice().sort(function (x, y) { return x - y; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Median minute-of-day that survives midnight wrap: rotate every member onto the
// first one's frame, take the median there, rotate back.
function spCircularMedian(minutes) {
  if (!minutes.length) return 0;
  var anchor = minutes[0];
  var mapped = minutes.map(function (m) { return anchor + spSignedCircularDelta(m, anchor); });
  var med = spMedian(mapped);
  return ((Math.round(med) % 1440) + 1440) % 1440;
}

// The most FREQUENT amount, not the mean: a mean of 110/110/110/120 is Rs 112.50,
// a figure the user has never once paid. Everything this module surfaces has to
// be something that actually happened. Ties go to the most recent.
function spMode(amounts) {
  var counts = new Map();
  var lastIndex = new Map();
  for (var i = 0; i < amounts.length; i++) {
    var key = spRound2(amounts[i]);
    counts.set(key, (counts.get(key) || 0) + 1);
    lastIndex.set(key, i);
  }
  var bestValue = null, bestCount = -1, bestIndex = -1;
  counts.forEach(function (count, key) {
    var idx = lastIndex.get(key);
    if (count > bestCount || (count === bestCount && idx > bestIndex)) {
      bestValue = key; bestCount = count; bestIndex = idx;
    }
  });
  return { value: bestValue, count: bestCount };
}

// ---- rows -> observations ----

// A row is a spend if it names an amount, otherwise a food log. An explicit
// source/table field wins so callers can be unambiguous.
function spRowKind(row) {
  var declared = String(row.source || row.table || row.kind || "").toLowerCase();
  if (declared.indexOf("ledger") === 0 || declared === "expense" || declared === "spend") return "spend";
  if (declared.indexOf("food") === 0 || declared === "meal") return "food";
  return row.amount == null ? "food" : "spend";
}

function spRowText(row) {
  return [row.description, row.meal_name, row.merchant, row.note, row.text]
    .filter(function (v) { return typeof v === "string" && v.trim(); })
    .join(" ");
}

// Splits raw rows into food logs and expense rows. Non-expense ledger rows
// (income, transfers) are not spend and are dropped; a spend row whose amount is
// not a finite positive number is a data fault and throws rather than being
// quietly read as zero.
function spSplitRows(rows, timeZone) {
  var foods = [], spends = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== "object") continue;
    var kind = spRowKind(row);
    var at = spInstant(row.occurred_at || row.occurredAt || row.at, "row " + (row.id == null ? i : row.id));
    var base = {
      id: row.id == null ? null : String(row.id),
      ingestionId: row.ingestion_id == null ? null : String(row.ingestion_id),
      at: at,
      minute: spMinuteOfDayInTz(at, timeZone),
      dateKey: spDateKeyInTz(at, timeZone),
      text: spRowText(row),
    };
    if (kind === "spend") {
      var direction = String(row.direction || "expense").toLowerCase();
      if (direction !== "expense") continue;
      var amount = Number(row.amount);
      if (!Number.isFinite(amount)) {
        throw new TypeError("spend-patterns: non-numeric amount on row " + String(base.id));
      }
      if (amount <= 0) continue; // a zero/negative "expense" carries no price signal
      base.amount = amount;
      spends.push(base);
    } else {
      foods.push(base);
    }
  }
  var byTime = function (a, b) { return a.at - b.at; };
  foods.sort(byTime);
  spends.sort(byTime);
  return { foods: foods, spends: spends };
}

// One capture ("egg curry roti with 3 eggs paid 110") lands as a food_logs row
// AND a ledger_entries row. Rejoining them is what makes a priced meal
// observable at all: the food row has the good description, the ledger row has
// the money. Same ingestion wins; otherwise nearest row inside the window.
function spPairObservations(foods, spends) {
  var used = new Set();
  var obs = [];
  for (var i = 0; i < foods.length; i++) {
    var f = foods[i];
    var best = -1, bestScore = Infinity;
    for (var j = 0; j < spends.length; j++) {
      if (used.has(j)) continue;
      var s = spends[j];
      var gap = Math.abs(s.at - f.at) / 60000;
      var sameIngestion = f.ingestionId && s.ingestionId && f.ingestionId === s.ingestionId;
      if (!sameIngestion && gap > SP_PAIR_WINDOW_MIN) continue;
      var score = sameIngestion ? -1 : gap;
      if (score < bestScore) { bestScore = score; best = j; }
    }
    if (best < 0) continue; // an unpriced meal is not evidence of a price
    var spend = spends[best];
    used.add(best);
    var tokens = spTokens(f.text);
    spTokens(spend.text).forEach(function (t) { tokens.add(t); });
    if (!tokens.size) continue;
    obs.push({
      tokens: tokens, amount: spend.amount, at: f.at, minute: f.minute,
      dateKey: f.dateKey, text: f.text || spend.text,
    });
  }
  // A spend that names its own goods ("egg curry roti 110" with no food row) is
  // still a real observation of that price.
  for (var k = 0; k < spends.length; k++) {
    if (used.has(k)) continue;
    var only = spends[k];
    var t = spTokens(only.text);
    if (!t.size) continue;
    obs.push({
      tokens: t, amount: only.amount, at: only.at, minute: only.minute,
      dateKey: only.dateKey, text: only.text,
    });
  }
  obs.sort(function (a, b) { return a.at - b.at; });
  return obs;
}

// ---- clustering ----

function spAmountCompatible(amount, reference) {
  var tol = Math.max(SP_AMOUNT_ABS_TOL, SP_AMOUNT_REL_TOL * reference);
  return Math.abs(amount - reference) <= tol;
}

// The cluster's identity is the tokens a strict majority of its members share -
// so one loosely-worded capture cannot drag the signature somewhere else. With a
// single member that is simply its own tokens.
function spCoreTokens(members) {
  var counts = new Map();
  for (var i = 0; i < members.length; i++) {
    members[i].tokens.forEach(function (t) { counts.set(t, (counts.get(t) || 0) + 1); });
  }
  var core = new Set();
  counts.forEach(function (count, token) {
    if (count * 2 > members.length) core.add(token);
  });
  if (!core.size) return new Set(members[members.length - 1].tokens);
  return core;
}

function spRefresh(cluster) {
  cluster.core = spCoreTokens(cluster.members);
  cluster.amountMedian = spMedian(cluster.members.map(function (m) { return m.amount; }));
  cluster.minuteMedian = spCircularMedian(cluster.members.map(function (m) { return m.minute; }));
}

function spClusterObservations(obs) {
  var clusters = [];
  for (var i = 0; i < obs.length; i++) {
    var o = obs[i];
    var best = null, bestSim = 0;
    for (var c = 0; c < clusters.length; c++) {
      var cl = clusters[c];
      if (!spAmountCompatible(o.amount, cl.amountMedian)) continue;
      if (spCircularDelta(o.minute, cl.minuteMedian) > SP_TIME_TOL_MIN) continue;
      var sim = spDice(o.tokens, cl.core);
      if (sim >= SP_SIM_MIN && sim > bestSim) { bestSim = sim; best = cl; }
    }
    if (best) {
      best.members.push(o);
      spRefresh(best);
    } else {
      var fresh = { members: [o] };
      spRefresh(fresh);
      clusters.push(fresh);
    }
  }
  return clusters;
}

// ---- confidence ----

// Asymptotic in the observation count and anchored at the support floor: the
// third sighting alone is worth 0.5, and only a long run approaches 1. Nothing
// here is a hardcoded confidence - every input is measured off the data.
function spSupportScore(n, minSupport) {
  if (n < minSupport) return 0;
  return 1 - 1 / (n - minSupport + 2);
}

// How tightly the amounts agree, as mean absolute deviation from the median
// expressed as a fraction of that median. Four identical Rs 110 -> 1.
function spAmountAgreement(amounts) {
  var med = spMedian(amounts);
  if (!(med > 0)) return 0;
  var dev = 0;
  for (var i = 0; i < amounts.length; i++) dev += Math.abs(amounts[i] - med);
  return spClamp(1 - (dev / amounts.length) / med, 0, 1);
}

// How tightly the sightings land at the same time of day, scaled by the same
// tolerance used to admit a member in the first place.
function spTimeTightness(minutes) {
  var med = spCircularMedian(minutes);
  var dev = 0;
  for (var i = 0; i < minutes.length; i++) dev += spCircularDelta(minutes[i], med);
  return spClamp(1 - (dev / minutes.length) / SP_TIME_TOL_MIN, 0, 1);
}

function spHhmm(minute) {
  var h = Math.floor(minute / 60), m = minute % 60;
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}

function spBuildPattern(cluster, minSupport) {
  var members = cluster.members;
  var amounts = members.map(function (m) { return m.amount; });
  var minutes = members.map(function (m) { return m.minute; });
  var mode = spMode(amounts);
  var tokens = Array.from(cluster.core).sort();
  var support = spSupportScore(members.length, minSupport);
  var amountAgreement = spAmountAgreement(amounts);
  var timeTightness = spTimeTightness(minutes);
  var first = members[0], last = members[members.length - 1];
  return {
    id: tokens.join("+") + "@" + spMoney(mode.value),
    tokens: tokens,
    label: tokens.join(" + "),
    // The amount is the most frequently OBSERVED one, never an average.
    amount: mode.value,
    amountModeCount: mode.count,
    amountMin: Math.min.apply(null, amounts),
    amountMax: Math.max.apply(null, amounts),
    amountAgreement: spRound2(amountAgreement),
    observations: members.length,
    supportScore: spRound2(support),
    typicalMinuteOfDay: cluster.minuteMedian,
    typicalTime: spHhmm(cluster.minuteMedian),
    timeTightness: spRound2(timeTightness),
    firstSeen: first.dateKey,
    lastSeen: last.dateKey,
    lastSeenAt: new Date(last.at).toISOString(),
    spanDays: spDayDiff(first.dateKey, last.dateKey),
    // The three or four sentences the user actually typed, so the offer can show
    // its working rather than assert a number.
    examples: members.slice(-3).map(function (m) { return m.text; }).filter(Boolean),
    confidence: spRound2(0.5 * support + 0.3 * amountAgreement + 0.2 * timeTightness),
  };
}

// detectPatterns(rows) - historical food_logs + ledger_entries in, recurring
// (signature, amount, time-of-day) clusters out. Clusters below the support
// floor are dropped entirely: there is no such thing as a low-confidence pattern
// here, only a pattern and not-yet-a-pattern.
function spDetectPatterns(rows, options) {
  if (!Array.isArray(rows)) throw new TypeError("detectPatterns: rows must be an array");
  var opts = options || {};
  var timeZone = opts.timeZone || SP_DEFAULT_TZ;
  // Callers may raise the bar, never lower it.
  var minSupport = Math.max(SP_MIN_SUPPORT, Math.floor(Number(opts.minSupport) || 0));
  var split = spSplitRows(rows, timeZone);
  var obs = spPairObservations(split.foods, split.spends);
  var clusters = spClusterObservations(obs);
  var patterns = [];
  for (var i = 0; i < clusters.length; i++) {
    if (clusters[i].members.length < minSupport) continue;
    patterns.push(spBuildPattern(clusters[i], minSupport));
  }
  patterns.sort(function (a, b) {
    return (b.confidence - a.confidence) || (b.observations - a.observations) || a.id.localeCompare(b.id);
  });
  return patterns;
}

// ---- suggestion ----

function spRelativeDay(days) {
  if (days == null) return "on an unknown day";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return days + " days ago";
  if (days < 60) return Math.round(days / 7) + " weeks ago";
  return Math.round(days / 30) + " months ago";
}

// The whole reason a suggestion is allowed to exist. Never returned empty, and
// never rendered without the counts and dates that back it.
function spEvidenceLine(pattern, daysSinceLast) {
  var line = "Rs " + spMoney(pattern.amount) + " - you've logged this " + pattern.observations + " times";
  if (pattern.amountModeCount < pattern.observations) {
    line += " (Rs " + spMoney(pattern.amount) + " on " + pattern.amountModeCount + " of them";
    if (pattern.amountMin !== pattern.amountMax) {
      line += ", range Rs " + spMoney(pattern.amountMin) + "-Rs " + spMoney(pattern.amountMax);
    }
    line += ")";
  }
  line += ", most recently " + spRelativeDay(daysSinceLast);
  return line;
}

// suggestForCapture(text, patterns, { now }) - a capture that names food but no
// price. Returns the matching pattern's typical amount WITH its evidence, or
// null. Null on: an amount already stated, no dish named, no pattern that clears
// the support floor, a signature that does not match, a pattern gone stale, or a
// match confidence under the bar. There is no path that returns a bare number.
function spSuggestForCapture(text, patterns, options) {
  if (!Array.isArray(patterns)) throw new TypeError("suggestForCapture: patterns must be an array");
  var opts = options || {};
  var timeZone = opts.timeZone || SP_DEFAULT_TZ;
  var nowMs = spInstant(opts.now == null ? new Date() : opts.now, "options.now");
  var raw = String(text == null ? "" : text);

  // The user already said what they paid - there is nothing to suggest, and
  // offering a remembered figure over a stated one would be the worst version
  // of this feature.
  if (extractAmount(raw) != null) return null;

  var tokens = spTokens(raw);
  if (!tokens.size) return null;

  var nowKey = spDateKeyInTz(nowMs, timeZone);
  var nowMinute = spMinuteOfDayInTz(nowMs, timeZone);

  var best = null;
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    if (!p || !Array.isArray(p.tokens) || !(p.observations >= SP_MIN_SUPPORT)) continue;
    if (!Number.isFinite(Number(p.amount)) || Number(p.amount) <= 0) continue;
    var sim = spDice(tokens, new Set(p.tokens));
    if (sim < SP_SIM_MIN) continue;
    var daysSinceLast = spDayDiff(p.lastSeen, nowKey);
    if (daysSinceLast == null) continue;
    // A price the user has not paid in weeks is a memory, not a prediction.
    if (daysSinceLast > SP_STALE_DAYS) continue;
    var timeProximity = spClamp(
      1 - spCircularDelta(nowMinute, Number(p.typicalMinuteOfDay) || 0) / SP_TIME_TOL_MIN, 0, 1,
    );
    // Signature fit and time-of-day fit can only ever DISCOUNT the confidence
    // the pattern itself earned from its own history.
    var confidence = spRound2(Number(p.confidence) * (0.6 + 0.25 * sim + 0.15 * timeProximity));
    if (confidence < SP_MIN_SUGGEST_CONFIDENCE) continue;
    if (!best || confidence > best.confidence) {
      best = {
        amount: Number(p.amount),
        currency: "INR",
        confidence: confidence,
        evidence: spEvidenceLine(p, daysSinceLast),
        patternId: p.id,
        label: p.label,
        matchedTokens: spIntersect(tokens, new Set(p.tokens)).sort(),
        signatureSimilarity: spRound2(sim),
        timeProximity: spRound2(timeProximity),
        observations: p.observations,
        amountModeCount: p.amountModeCount,
        amountMin: p.amountMin,
        amountMax: p.amountMax,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        daysSinceLast: daysSinceLast,
        typicalTime: p.typicalTime,
        examples: Array.isArray(p.examples) ? p.examples : [],
        // Consumed by the UI: this is an offer to tap, never an applied write.
        action: "confirm_expense",
      };
    }
  }
  return best;
}
// ==== SPEND-PATTERNS MIRROR END ====

export {
  SP_MIN_SUPPORT, SP_SIM_MIN, SP_STALE_DAYS, SP_TIME_TOL_MIN, SP_MIN_SUGGEST_CONFIDENCE,
  spTokens, spDice, spMode, spMedian, spCircularDelta, spCircularMedian,
  spSupportScore, spAmountAgreement, spTimeTightness, spEvidenceLine, spRelativeDay,
  spDetectPatterns as detectPatterns,
  spSuggestForCapture as suggestForCapture,
};
