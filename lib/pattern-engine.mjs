// BEHAVIOURAL PATTERN ENGINE - "every Saturday you have pizza", said only when it
// is true.
//
// Pure: no DOM, no Supabase, no clock reads except the `now` you pass in.
//
// THE DEEPEST RULE IN THIS FILE, and the reason several gates look too strict:
// DO NOT LET THE TARGET CHASE THE ACTUAL. If a detected pattern is allowed to
// rewrite the plan, the plan converges on behaviour, adherence is always 100% and
// the tracker measures nothing. The gap between intention and behaviour IS the
// product. So this module returns OBSERVATIONS, never tool calls, and only a
// proven REPLACEMENT (or an explicit user statement) may even PROPOSE a plan
// edit - which then travels the normal confirm gate like every other write.
//
// THE DATA THIS IS SIZED FOR (measured on the live DB, 2026-08-06):
//   food_logs     77 rows / 44 days = 1.75 meals/day
//   workout_logs  18 rows / 39 days
//   day-of-week meal counts: Sun 6, Sat 9, Mon 8
// Six Sundays. That is the whole sample behind "Sunday averages 829 kcal vs
// Monday 392". Most cells therefore CANNOT clear a defensible bar, and saying so
// is the correct output - which is why every silence lands in `suppressed[]` with
// the gate that produced it. An engine that cannot explain its silence cannot be
// debugged, and this codebase's recurring bug is exactly the opposite habit:
// absent data rendered as a measured 0 and then narrated as fact.
//
// WHY NOT CHI-SQUARE. The obvious test for "is this weekday special" is a
// goodness-of-fit chi-square over the 7 weekdays. It is invalid here and it fails
// in the dangerous direction. With k = 6 ice-cream events the expected count per
// weekday is 6/7 = 0.86, an order of magnitude below the conventional validity
// floor of 5 per cell. Below that floor the (O-E)^2/E terms are dominated by
// tiny denominators, so the statistic is inflated and the test MANUFACTURES
// significance precisely in the small-n regime this app lives in. Exact methods
// are used throughout instead: exact binomial tail, Wilson score interval,
// Fisher's exact test. None of them has a minimum-count assumption.

import { estimateNutrition, categoryChainOf, categoryParentOf } from "./food-nutrition.mjs";
import { spTokens, spDice, spCircularMedian } from "./spend-patterns.mjs";
import { mealSlotFromTime } from "./fan-out-expander.mjs";
import { DEFAULT_TZ, WEEKDAY_NAMES, dayKeyInTz, weekdayInTz, minuteOfDayInTz, isoWeekKeyInTz, addDays, dayDiff, hhmm, toInstantMs } from "./tz.mjs";

// ---------------------------------------------------------------------------
// Gate constants. Each one is a number a reviewer can argue with; none is a
// vibe. The worked arithmetic for the whole table is in tests/pattern-engine.
// ---------------------------------------------------------------------------
export const PE_MIN_SUPPORT = 3;      // matches SP_MIN_SUPPORT in spend-patterns
export const PE_MIN_WEEKS = 3;        // DISTINCT ISO weeks, not distinct rows
export const PE_COVERAGE_FLOOR = 0.5;
export const PE_COVERAGE_Z = 1.2816;  // one-sided 90%
export const PE_SPECIFICITY_ALPHA = 0.05;
export const PE_MIN_LIFT = 2;
export const PE_LIFT_CAP = 7;         // a 7-day week: everything on one weekday
export const PE_BH_Q = 0.1;
export const PE_HALF_LIFE_DAYS = 21;  // steady-state recency weight
export const PE_CUT_MIN = 3;          // mini-ADWIN: earliest detectable switch
export const PE_CUT_MAX = 21;
export const PE_CUT_COUNT = PE_CUT_MAX - PE_CUT_MIN + 1; // 19 cut points
export const PE_CHANGEPOINT_ALPHA = 0.05 / PE_CUT_COUNT; // 2.632e-3, Bonferroni
export const PE_CONTRADICTION_Z = 1.6449;   // one-sided 95%
export const PE_CONTRADICTION_CEILING = 0.6;
export const PE_DICE_MIN = 0.4;       // same threshold spend-patterns proved out
export const PE_TRIGRAM_MIN = 0.6;
export const PE_WINDOW_DAYS = 90;

// Precedence, NOT averaging. An instruction and a measurement are not two noisy
// readings of the same quantity - "I eat eggs every morning" is a statement of
// intent that the logs can CONTRADICT but cannot dilute. Averaging a stated 1.00
// with an observed 0.29 to get 0.65 would be a number describing nothing.
export const CONFIDENCE = { STATED: 1, CONFIRMED: 0.9, SINGLE: 0.33 };

// ===========================================================================
// 1. STATISTICS
// ===========================================================================

// Lanczos g=7, n=9. Accurate to ~15 significant digits over the range we use.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// log C(n,k) via lgamma. Doing this in log space is not fastidiousness: the
// changepoint scan builds hypergeometric terms with n up to 90, and C(90,45) is
// 1.1e26 - representable, but the products around it are not, and the naive form
// silently returns Infinity/Infinity = NaN, which compares false against every
// threshold and therefore fails SILENTLY as "no pattern".
export function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

function logSumExp(a, b) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = a > b ? a : b;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

// P(X >= k) for X ~ Binomial(n, p). The specificity test: "if this item were
// equally likely on any weekday (p = 1/7), how surprised should I be that k of
// its n occurrences landed on Saturday?"
export function binomialUpperTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let acc = -Infinity;
  for (let i = k; i <= n; i++) acc = logSumExp(acc, logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, Math.exp(acc));
}

// Wilson score interval, counts form. Chosen over Wald for one concrete reason:
// at 4 successes in 4 trials Wald's sqrt(p(1-p)/n) is exactly 0, so it reports
// the interval [1.00, 1.00] - false certainty from four data points, the single
// worst failure mode for a module whose job is to know when to shut up. Wilson's
// centre is pulled toward 0.5 by z^2/2n and its width never collapses.
//   4/4 at z=1.2816 -> [0.709, 1.000]. Honest.
export function wilsonInterval(successes, trials, z = PE_COVERAGE_Z) {
  const n = Number(trials);
  if (!Number.isFinite(n) || n <= 0) return { lo: 0, hi: 1, centre: 0.5 };
  const s = Math.max(0, Math.min(n, Number(successes)));
  const p = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), centre };
}
export const wilsonLowerBound = (s, n, z = PE_COVERAGE_Z) => wilsonInterval(s, n, z).lo;
export const wilsonUpperBound = (s, n, z = PE_COVERAGE_Z) => wilsonInterval(s, n, z).hi;

// One-sided Fisher exact test on [[a,b],[c,d]], H1: the first row's rate is
// HIGHER. Sums hypergeometric probabilities from the observed table upward.
// Used for changepoints because the recent window is tiny by construction (3-21
// days) and every large-sample test is invalid there.
export function fisherExactGreater(a, b, c, d) {
  const n = a + b + c + d;
  if (n <= 0) return 1;
  const row1 = a + b;
  const col1 = a + c;
  const hi = Math.min(row1, col1);
  const denom = logChoose(n, col1);
  let acc = -Infinity;
  for (let x = a; x <= hi; x++) {
    const term = logChoose(row1, x) + logChoose(n - row1, col1 - x);
    if (term === -Infinity) continue;
    acc = logSumExp(acc, term - denom);
  }
  return Math.min(1, Math.exp(acc));
}

// Benjamini-Hochberg. Returns a boolean per input p-value.
//
// WHY NOT BONFERRONI, as a number rather than an opinion: the family here is
// (items x weekdays). At 40 tracked items that is 40 x 7 = 280 tests, so
// Bonferroni's threshold is 0.05/280 = 1.79e-4. Four consecutive Saturdays of
// pizza has p = (1/7)^4 = 4.16e-4. Bonferroni would suppress the EXACT case the
// owner asked for, and would do it silently. BH controls the false DISCOVERY
// rate instead: at q = 0.10, one in ten surfaced patterns may be noise, which is
// the right trade when the cost of a miss is "the app never noticed" and the
// cost of a false positive is one dismissable message.
export function benjaminiHochberg(pvalues, q = PE_BH_Q) {
  const m = pvalues.length;
  const out = new Array(m).fill(false);
  if (!m) return out;
  const order = pvalues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  let kmax = -1;
  for (let r = 0; r < m; r++) if (order[r].p <= ((r + 1) / m) * q) kmax = r;
  for (let r = 0; r <= kmax; r++) out[order[r].i] = true;
  return out;
}

// ===========================================================================
// 2. ITEM IDENTITY - three deterministic layers
// ===========================================================================

// Padded character trigrams. The padding is load-bearing: without it "chai" and
// "chaat" share only {cha} out of 4 trigrams (J = 0.25) and the pair looks safe
// at any threshold, which hides how close they really are. Padded they share
// {"  c", " ch", "cha"} of 8 (J = 0.375) - which is why 0.30 is NOT a usable
// threshold and this layer sits at 0.60.
export function trigrams(text) {
  const s = `  ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}
export function trigramJaccard(a, b) {
  const A = a instanceof Set ? a : trigrams(a);
  const B = b instanceof Set ? b : trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter += 1; });
  return inter / (A.size + B.size - inter);
}

// LAYER 1 is authoritative and LAYER 3 may never override it. Concretely: if the
// FOOD_TABLE resolves two texts to different keys, they are different items even
// at trigram J = 0.9. "chai" and "chaat" are both in the table; letting the fuzzy
// layer merge them would put a tea habit and a street-snack habit in one cell and
// then narrate the union.
export function identityOf(text, { category = null } = {}) {
  const raw = String(text || "").trim();
  const est = estimateNutrition(raw);                        // LAYER 1: alias lookup
  const keys = est.items.map((i) => i.key);
  const cats = new Set();
  for (const k of keys) for (const c of categoryChainOf(k)) cats.add(c);
  if (category) cats.add(String(category));
  return {
    text: raw,
    keys,
    categories: [...cats],
    tokens: spTokens(raw),                                   // LAYER 2 input
    trigrams: trigrams(raw),                                 // LAYER 3 input
    tableResolved: keys.length > 0,
  };
}

// Same item? Returns the layer that decided, so a wrong merge is traceable to a
// threshold rather than to "the fuzzy matcher".
export function sameItem(a, b) {
  const A = typeof a === "string" ? identityOf(a) : a;
  const B = typeof b === "string" ? identityOf(b) : b;
  if (A.tableResolved || B.tableResolved) {
    const sameKeys = A.keys.length === B.keys.length && A.keys.every((k) => B.keys.includes(k));
    // Authoritative both ways: a table match that agrees is a match, and a table
    // match that disagrees is a NON-match that the fuzzy layers cannot appeal.
    return { same: A.tableResolved && B.tableResolved && sameKeys, layer: 1 };
  }
  const dice = spDice(A.tokens, B.tokens);
  if (dice >= PE_DICE_MIN) return { same: true, layer: 2, score: dice };
  const tri = trigramJaccard(A.trigrams, B.trigrams);
  if (tri >= PE_TRIGRAM_MIN) return { same: true, layer: 3, score: tri };
  return { same: false, layer: 3, score: Math.max(dice, tri) };
}

// ===========================================================================
// 3. NORMALISATION - rows to (day, weekday, week, minute, item, category)
// ===========================================================================

// Meal-slot bands are NOT redefined here. They are PROBED out of the canonical
// mealSlotFromTime in fan-out-expander.mjs at import time, so a change to the
// bands there propagates rather than drifting. (A hand-copied second band table
// was a real bug in this repo once already - FOOD_WORDS.)
const IST_OFFSET_MIN = 330;
const HOUR_BAND = (() => {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const utcMs = Date.UTC(2026, 0, 8, h, 0, 0) - IST_OFFSET_MIN * 60000;
    out.push(mealSlotFromTime(new Date(utcMs).toISOString()));
  }
  return out;
})();
export const bandForHour = (h) => HOUR_BAND[((Math.floor(h) % 24) + 24) % 24];

const DOMAIN_OF = { food: "food", food_log: "food", workout: "workout", workout_log: "workout", spend: "spend", expense: "spend", ledger: "spend" };

// Returns a normalised row, or `{ dropped: <reason> }`. A row this module cannot
// place in time is NOT silently discarded: it goes into `suppressed[]` like every
// other silence. Dropping unparseable rows quietly is how a whole week of
// captures can vanish from a pattern and leave the engine confidently reporting
// on the rest - the exact failure mode this repo has already had to chase down
// in the capture pipeline.
function normalizeEvent(ev, tz) {
  const at = ev.at ?? ev.occurred_at ?? ev.logged_at ?? ev.date;
  if (at == null) return { dropped: "event_without_timestamp" };
  let ms;
  try {
    ms = toInstantMs(at, "event");
  } catch (err) {
    return { dropped: "event_timestamp_unparseable", detail: err.message };
  }
  const text = ev.description ?? ev.meal_name ?? ev.title ?? ev.name ?? ev.counterparty ?? "";
  const ident = identityOf(text, { category: ev.category });
  const minute = minuteOfDayInTz(ms, tz);
  return {
    ms,
    dayKey: dayKeyInTz(ms, tz),
    weekday: weekdayInTz(ms, tz),
    week: isoWeekKeyInTz(ms, tz),
    minute,
    band: bandForHour(Math.floor(minute / 60)),
    domain: DOMAIN_OF[ev.kind] || DOMAIN_OF[ev.domain] || "food",
    text,
    keys: ev.itemKey ? [String(ev.itemKey)] : ident.keys,
    categories: ident.categories,
    ident,
  };
}

// Events whose text the FOOD_TABLE does not know still deserve identity, or every
// gym session ("incline dumbbell press") is its own singleton and nothing is ever
// a pattern. Cluster them with layers 2 and 3, first-seen text as the label.
function clusterUnresolved(rows) {
  const reps = [];
  for (const r of rows) {
    if (r.keys.length) continue;
    if (!r.ident.tokens.size && !r.text) continue;
    let hit = null;
    for (const rep of reps) {
      const m = sameItem(r.ident, rep.ident);
      if (m.same) { hit = rep; break; }
    }
    if (!hit) { hit = { key: `~${r.text.toLowerCase().slice(0, 40)}`, ident: r.ident }; reps.push(hit); }
    r.keys = [hit.key];
  }
}

// ===========================================================================
// 4. THE FOUR GATES
// ===========================================================================
//
// s  = distinct DAYS the item occurred on this weekday (never rows: three pizza
//      slices in one evening is one Saturday, and counting rows is how "I binged
//      once" becomes "every Saturday")
// W  = occurrences of this weekday in the window on which ANY event of the
//      item's domain was logged. A holiday week with zero logs is NOT an
//      opportunity the user declined - it is a week we know nothing about, and
//      counting it would let silence erode a real 4/4 pattern.
// kT = distinct days the item occurred on, across all weekdays
// D  = observed days in the window for that domain
export function gateCell({ s, W, kTotal, weeks, dObserved }) {
  const rate = W > 0 ? s / W : 0;
  const otherDays = dObserved - W;
  const otherHits = kTotal - s;
  // Lift is this weekday's rate against every OTHER observed day's rate. When the
  // item happens on no other day the ratio is unbounded, so cap at 7 - the most
  // concentration a 7-day week can hold. This definition (rather than rate/(1/7))
  // is what makes a DAILY item score lift ~1.0 and therefore make no weekday
  // claim at all, which is the behaviour asked for.
  const lift = otherDays > 0 && otherHits > 0
    ? Math.min(PE_LIFT_CAP, rate / (otherHits / otherDays))
    : (s > 0 ? PE_LIFT_CAP : 0);
  const coverage = wilsonLowerBound(s, W, PE_COVERAGE_Z);
  const p = binomialUpperTail(s, kTotal, 1 / 7);
  const failures = [];
  if (s < PE_MIN_SUPPORT) failures.push("support_below_floor");
  if (weeks < PE_MIN_WEEKS) failures.push("span_below_floor");
  if (coverage < PE_COVERAGE_FLOOR) failures.push("coverage_below_floor");
  if (p > PE_SPECIFICITY_ALPHA) failures.push("specificity_not_significant");
  if (lift < PE_MIN_LIFT) failures.push("lift_below_floor");
  return { s, W, kTotal, weeks, rate, lift, coverage, p, pass: failures.length === 0, failures };
}

// ===========================================================================
// 5. CHANGEPOINT - mini-ADWIN
// ===========================================================================
//
// The 21-day half-life keeps the STEADY-STATE detector honest, but a half-life is
// a low-pass filter and a diet SWITCH is a step function; asking a 21-day
// exponential to notice a 4-day-old change means waiting ~6 weeks for the old
// regime to decay out. So a switch gets its own detector: try every cut point
// 3..21 days back, Fisher-exact the recent window against the older one, and
// Bonferroni over the 19 cuts (alpha = 0.05/19 = 2.632e-3). Bonferroni is right
// HERE and wrong for the weekday family because 19 highly-correlated cuts of one
// series is a small, genuinely multiple-testing problem, not a discovery scan.
//
// Measured latencies against alpha = 2.632e-3 (tests assert every one of these):
//   3 new days, 3/3, clean 14-day prior -> 1/C(17,3) = 1.471e-3  DETECTED
//   2 new days, 2/2, clean 14-day prior -> 1/C(16,2) = 8.333e-3  not yet
//   4 new days, 4/4, clean  8-day prior -> 1/C(12,4) = 2.020e-3  DETECTED
//   4 new days, 4/4, clean  7-day prior -> 1/C(11,4) = 3.030e-3  just misses
// Three days against an established prior; the "6 eggs daily" case needs four,
// and if its prior is only a week long it needs the fourth day AND an eighth day
// of history. That last line is the honest edge, and it is in a test so nobody
// has to rediscover it from a bug report. Not six weeks either way.
export function detectChangepoint(hitDayKeys, observedDayKeys, { now, tz = DEFAULT_TZ } = {}) {
  const today = dayKeyInTz(now, tz);
  const hits = hitDayKeys instanceof Set ? hitDayKeys : new Set(hitDayKeys);
  const observed = [...(observedDayKeys instanceof Set ? observedDayKeys : new Set(observedDayKeys))].sort();
  if (observed.length < PE_CUT_MIN + 1) return null;
  let best = null;
  for (let cut = PE_CUT_MIN; cut <= PE_CUT_MAX; cut++) {
    const cutKey = addDays(today, -(cut - 1));
    let a = 0, b = 0, c = 0, d = 0;
    for (const day of observed) {
      const recent = day >= cutKey;
      const hit = hits.has(day);
      if (recent) { if (hit) a += 1; else b += 1; } else if (hit) c += 1; else d += 1;
    }
    // One day is never a regime. This is the same floor as CONFIDENCE.SINGLE:
    // a single observation may be reported, never acted on.
    if (a < 2 || a + b < PE_CUT_MIN || c + d < PE_CUT_MIN) continue;
    const pRose = fisherExactGreater(a, b, c, d);
    const pFell = fisherExactGreater(c, d, a, b);
    const p = Math.min(pRose, pFell);
    if (p > PE_CHANGEPOINT_ALPHA) continue;
    const cand = {
      cutKey, cutDaysAgo: cut, p, direction: pRose <= pFell ? "rose" : "fell",
      recent: { hits: a, days: a + b }, prior: { hits: c, days: c + d },
    };
    // Ties go to the LARGER cut: the earliest instant consistent with the change,
    // which also truncates the least history when patterns are recomputed.
    if (!best || cand.p < best.p - 1e-12) best = cand;
  }
  return best;
}

// REPLACEMENT vs ADDITION - the crux, and the whole reason a pattern may not
// write. Same Fisher test on the INCUMBENT, reversed.
//   newRose &&  oldFell -> REPLACEMENT  (the slot changed hands; may PROPOSE)
//   newRose && !oldFell -> ADDITION     (a heads-up; zero plan edits, ever)
// One Saturday of pizza is s = 1 and dies at the support floor long before this.
// Four Saturdays of pizza while lunch is unchanged is an ADDITION: real, worth
// saying, and not evidence that lunch is now pizza.
export function classifyShift(newChange, incumbentChange) {
  const newRose = !!newChange && newChange.direction === "rose";
  const oldFell = !!incumbentChange && incumbentChange.direction === "fell";
  if (!newRose) return { type: "none", proposesPlanChange: false };
  return {
    type: oldFell ? "replacement" : "addition",
    proposesPlanChange: !!oldFell,
    incumbentP: incumbentChange ? incumbentChange.p : null,
  };
}

// ===========================================================================
// 6. CONFIDENCE HIERARCHY AND CONTRADICTION
// ===========================================================================

export function resolveConfidence({ stated = false, confirmed = false, contradicted = false, support = 0, coverage = 0 } = {}) {
  if (stated && !contradicted) return { tier: "STATED", value: CONFIDENCE.STATED, mayWrite: true };
  if (confirmed) return { tier: "CONFIRMED", value: CONFIDENCE.CONFIRMED, mayWrite: true };
  if (support >= PE_MIN_SUPPORT) return { tier: "OBSERVED", value: Number(coverage.toFixed(4)), mayWrite: true };
  // A single sighting is reportable and never writable. This is the guard against
  // "one pizza on one Saturday" ever reaching the plan.
  return { tier: "SINGLE", value: CONFIDENCE.SINGLE, mayWrite: false };
}

// A STATED fact is removed only by CONTRADICTION, never by a low count. The test
// is the Wilson UPPER bound against the claim: could the logs still be consistent
// with "most days"? At z = 1.6449 (one-sided 95%):
//   2 of 7 -> UB = 0.591 < 0.60  CONTRADICTED
//   3 of 7 -> UB = 0.711 >= 0.60 not contradicted, stay quiet
// Then ask ONCE and go quiet for 14 days. Three options, and THE MIDDLE ONE
// MATTERS MOST: "I ate them but didn't log it" means those days are not evidence
// of absence, and leaving them in poisons every other pattern that shares the
// window. `excludeDays` is what the caller feeds back into `gapDays`.
export function checkContradiction(statement, { observed = 0, opportunities = 0, now, tz = DEFAULT_TZ } = {}) {
  if (opportunities <= 0) return { contradicted: false, reason: "no_opportunities" };
  const ub = wilsonUpperBound(observed, opportunities, PE_CONTRADICTION_Z);
  if (ub >= PE_CONTRADICTION_CEILING) return { contradicted: false, upperBound: Number(ub.toFixed(4)) };
  const today = dayKeyInTz(now, tz);
  return {
    contradicted: true,
    upperBound: Number(ub.toFixed(4)),
    subject: statement && statement.subject ? statement.subject : null,
    observed, opportunities,
    askOnce: true,
    quietUntil: addDays(today, 14),
    options: [
      { id: "plan_changed", label: "The plan changed", effect: "retire_statement" },
      { id: "logging_gap", label: "I did it but didn't log it", effect: "exclude_days_from_all_patterns" },
      { id: "off_track", label: "Keep it, I'm off-track", effect: "keep_statement_flag_adherence" },
    ],
  };
}

// ===========================================================================
// 7. MAIN
// ===========================================================================

export function detectPatterns(input = {}, options = {}) {
  const tz = options.tz || DEFAULT_TZ;
  const now = options.now instanceof Date ? options.now : new Date(options.now || 0);
  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : PE_WINDOW_DAYS;
  const today = dayKeyInTz(now, tz);
  const from = addDays(today, -(windowDays - 1));
  const gapDays = new Set(input.gapDays || []);
  const statements = Array.isArray(input.stated) ? input.stated : [];

  const suppressed = [];
  const note = (reason, extra) => suppressed.push({ reason, ...extra });

  const rows = [];
  for (const ev of Array.isArray(input.events) ? input.events : []) {
    const r = normalizeEvent(ev, tz);
    if (r.dropped) { note(r.dropped, { detail: r.detail || null }); continue; }
    if (r.dayKey < from || r.dayKey > today) continue;
    // A day the user told us was unlogged is not evidence either way. Dropping it
    // from BOTH numerator and denominator is the only correct handling; leaving
    // it in the denominator would silently convert "I forgot" into "I skipped".
    if (gapDays.has(r.dayKey)) continue;
    rows.push(r);
  }
  // CANONICAL ORDER before anything reads the rows. Three things downstream are
  // otherwise sensitive to the order the caller happened to fetch in: the fuzzy
  // cluster's first-seen representative, spCircularMedian's anchor (it rotates
  // onto minutes[0]), and Map insertion order, which decides the order of
  // `suppressed`. Same rows in, same JSON out - a diagnosis that changes when you
  // re-run the query is not a diagnosis.
  rows.sort((a, b) => a.ms - b.ms || a.text.localeCompare(b.text) || a.domain.localeCompare(b.domain));
  clusterUnresolved(rows);

  if (!rows.length) {
    note("window_empty", { from, to: today, events: 0 });
    return { observations: [], suppressed, changepoints: [], conflicts: [], meta: { tz, from, to: today, days: 0, events: 0 } };
  }

  // --- grids -------------------------------------------------------------
  const observedByDomain = new Map();   // domain -> Set(dayKey)
  for (const r of rows) {
    if (!observedByDomain.has(r.domain)) observedByDomain.set(r.domain, new Set());
    observedByDomain.get(r.domain).add(r.dayKey);
  }
  // item id -> { id, label, level, domain, days:Map(dayKey -> [rows]) }
  const items = new Map();
  const touch = (id, label, level, domain) => {
    let it = items.get(id);
    if (!it) { it = { id, label, level, domain, days: new Map() }; items.set(id, it); }
    return it;
  };
  for (const r of rows) {
    for (const k of r.keys) {
      const it = touch(`${r.domain}:key:${k}`, k, "key", r.domain);
      if (!it.days.has(r.dayKey)) it.days.set(r.dayKey, []);
      it.days.get(r.dayKey).push(r);
    }
    // CATEGORY level is what makes the flagship requirement work at all. "pizza
    // or going out with friends" is a category, not a dish: pizza x2 + burger x2
    // across four Saturdays is s = 2 at key level (dead at the floor) and s = 4
    // at `indulgence` level (fires). Without this the owner's own example fails.
    for (const c of r.categories) {
      const it = touch(`${r.domain}:cat:${c}`, c, "category", r.domain);
      if (!it.days.has(r.dayKey)) it.days.set(r.dayKey, []);
      it.days.get(r.dayKey).push(r);
    }
  }

  // --- changepoints ------------------------------------------------------
  const raw = [];
  const cutByItem = new Map();
  for (const it of items.values()) {
    // The modal hour band of an item is what makes "the slot changed hands"
    // testable: a dinner that appeared while lunch stayed put is an addition, no
    // matter how loudly both moved.
    const evs = [...it.days.values()].flat();
    const bands = new Map();
    for (const e of evs) bands.set(e.band, (bands.get(e.band) || 0) + 1);
    it.band = [...bands.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || null;
    const cp = detectChangepoint(new Set(it.days.keys()), observedByDomain.get(it.domain), { now, tz });
    if (!cp) continue;
    raw.push({ item: it.label, level: it.level, domain: it.domain, band: it.band, itemId: it.id, ...cp });
    // Pre-change data is not evidence about the present. Truncating is the whole
    // point: after a switch, the old regime's weeks must stop voting.
    if (cp.direction === "rose") cutByItem.set(it.id, cp.cutKey);
  }

  // REPLACEMENT vs ADDITION, resolved against a real incumbent rather than
  // assumed. The incumbent is the item that FELL in the same domain, at the same
  // level and in the same meal band, around the same time (within 3 days of the
  // cut - two Fisher scans on two different series will not agree to the day).
  // Ties break on the longer prior history, then alphabetically, so the answer is
  // deterministic for a frozen `now`.
  const changepoints = raw.map((cp) => {
    let incumbent = null;
    if (cp.direction === "rose") {
      incumbent = raw
        .filter((o) => o.direction === "fell" && o.domain === cp.domain && o.level === cp.level
          && o.band === cp.band && o.itemId !== cp.itemId && Math.abs(dayDiff(o.cutKey, cp.cutKey)) <= 3)
        .sort((a, b) => b.prior.hits - a.prior.hits || a.item.localeCompare(b.item))[0] || null;
    }
    const shift = classifyShift(cp, incumbent);
    return {
      ...cp,
      incumbent: incumbent ? incumbent.item : null,
      shift: shift.type,
      // An ADDITION never proposes anything. Four Saturdays of pizza while lunch
      // is untouched is news, not a new lunch plan.
      proposesPlanChange: shift.proposesPlanChange,
      planEdits: [],
      evidence: `${cp.recent.hits} of the last ${cp.recent.days} logged days, ${cp.prior.hits} of the ${cp.prior.days} before`,
    };
  });

  // --- prune, gate, collect p-values ------------------------------------
  const candidates = [];
  for (const it of items.values()) {
    // ANCHOR: the window for an item starts at its FIRST occurrence (or at a
    // detected changepoint, whichever is later), never at the start of history.
    //
    // Why, with the number that forced it: run the flagship case - four
    // consecutive Saturdays of pizza - against six weeks of otherwise ordinary
    // logs and you get s = 4, W = 6, Wilson LB = 0.409, no pattern. Against 90
    // days you get 4/13 and it would take half a year to fire. Saturdays before
    // the user had ever ordered a pizza are not Saturdays on which they declined
    // one; the habit did not exist yet. Anchoring is also what makes the agreed
    // gate table (3/3, 4/4, 4/5, 5/6 ...) reachable in real data at all - those
    // ratios only ever occur in an anchored window.
    //
    // The bias this buys, stated plainly: the first trial is a guaranteed
    // success, so 4/4 is really "3/3 plus one free hit". Three things bound it -
    // the support floor of 3 distinct days, the span floor of 3 distinct ISO
    // weeks, and the specificity test, which runs on kTotal and is completely
    // untouched by where the window starts. A habit that lapses is NOT protected:
    // the anchor only moves the left edge, so 3 pizzas then 3 empty Saturdays is
    // 3/6, LB 0.268, silent.
    const firstHit = [...it.days.keys()].sort()[0];
    const cut = [cutByItem.get(it.id) || from, firstHit].sort().pop();
    const observedAll = [...observedByDomain.get(it.domain)].filter((d) => d >= cut);
    const dObserved = observedAll.length;
    const hitDays = [...it.days.keys()].filter((d) => d >= cut);
    const kTotal = hitDays.length;
    if (kTotal === 0) continue;

    // A DAILY item makes no weekday claim. Reported as its own kind so the app
    // can still say "you have chai basically every day" without ever attaching a
    // weekday to it.
    const dailyCoverage = wilsonLowerBound(kTotal, dObserved, PE_COVERAGE_Z);
    const dailyWeeks = new Set(hitDays.map((d) => isoWeekKeyInTz(`${d}T12:00:00Z`, tz))).size;
    const isDaily = kTotal >= PE_MIN_SUPPORT && dailyWeeks >= PE_MIN_WEEKS && dailyCoverage >= PE_COVERAGE_FLOOR;
    if (isDaily) {
      // p is null, not 1 and not 0: "how surprising is it that this lands on a
      // given weekday" has no meaning for something that happens every day, and
      // writing a number there would be the exact bug this repo keeps re-fixing -
      // an absent measurement rendered as a measured value.
      candidates.push({ it, kind: "daily", cut, dObserved, onDay: hitDays, cell: { s: kTotal, W: dObserved, kTotal, weeks: dailyWeeks, coverage: dailyCoverage, lift: 1, p: null, rate: kTotal / dObserved }, p: null });
    }

    for (let wd = 0; wd < 7; wd++) {
      const W = observedAll.filter((d) => weekdayInTz(`${d}T12:00:00Z`, tz) === wd).length;
      const onDay = hitDays.filter((d) => weekdayInTz(`${d}T12:00:00Z`, tz) === wd);
      const s = onDay.length;
      if (s === 0) continue;
      const weeks = new Set(onDay.map((d) => isoWeekKeyInTz(`${d}T12:00:00Z`, tz))).size;
      const cell = gateCell({ s, W, kTotal, weeks, dObserved });
      const base = { item: it.label, level: it.level, domain: it.domain, weekday: wd, weekdayName: WEEKDAY_NAMES[wd], s, W, kTotal, weeks, lift: Number(cell.lift.toFixed(2)), coverage: Number(cell.coverage.toFixed(4)), p: cell.p };
      if (isDaily) { note("daily_item_no_weekday_claim", base); continue; }
      // PRUNE BY SUPPORT AND LIFT FIRST. Cheap, evidence-based, and it keeps the
      // p-value family small enough that BH has power - a scan that tests every
      // (item, weekday) cell spends its whole error budget on cells with s = 1.
      if (!cell.pass) { note(cell.failures[0], { ...base, failures: cell.failures }); continue; }
      candidates.push({ it, kind: "weekday", weekday: wd, cut, dObserved, cell, p: cell.p, onDay });
    }
  }

  // --- BH on the survivors ----------------------------------------------
  const weekdayCands = candidates.filter((c) => c.kind === "weekday");
  const keep = benjaminiHochberg(weekdayCands.map((c) => c.p), PE_BH_Q);
  const observations = [];
  for (const c of candidates.filter((x) => x.kind === "daily")) {
    observations.push(buildObservation(c, { tz, now, changepoints, statements, suppressed }));
  }
  // Specificity rank, lowest wins: a dish beats a leaf category beats a rollup.
  const rankOf = (c) => (c.it.level === "key" ? 0 : (categoryParentOf(c.it.label) ? 1 : 2));
  const survivors = weekdayCands.filter((c, i) => {
    if (keep[i]) return true;
    note("failed_benjamini_hochberg", { item: c.it.label, weekday: c.weekday, weekdayName: WEEKDAY_NAMES[c.weekday], s: c.cell.s, W: c.cell.W, p: c.p, q: PE_BH_Q });
    return false;
  }).sort((a, b) => rankOf(a) - rankOf(b) || a.p - b.p);

  // SUBSUMPTION. The category level exists to RESCUE a split key (pizza x2 +
  // burger x2 = indulgence x4), not to restate one that already fired. When
  // "pizza slice", "fastfood" and "indulgence" all cover the identical four
  // Saturdays, that is ONE fact and the user must hear the sharpest version of
  // it once - three near-identical sentences read as a broken app, and the nudge
  // budget would spend a whole day on whichever won a sort.
  const kept = [];
  for (const c of survivors) {
    const days = new Set(c.onDay);
    const parent = kept.find((k) => k.weekday === c.weekday && k.it.domain === c.it.domain
      && k.onDay.length === days.size && k.onDay.every((d) => days.has(d)));
    if (parent) {
      note("subsumed_by_more_specific", { item: c.it.label, level: c.it.level, by: parent.it.label, weekday: c.weekday, weekdayName: WEEKDAY_NAMES[c.weekday], s: c.cell.s, W: c.cell.W });
      continue;
    }
    kept.push(c);
  }
  for (const c of kept) observations.push(buildObservation(c, { tz, now, changepoints, statements, suppressed }));

  // --- stated vs observed ------------------------------------------------
  const conflicts = [];
  for (const st of statements) {
    const domain = st.domain || "food";
    const observed = observedByDomain.get(domain) || new Set();
    const key = st.itemKey || st.subject;
    const it = items.get(`${domain}:key:${key}`) || items.get(`${domain}:cat:${key}`);
    const opportunities = st.cadence === "weekly" && Number.isFinite(st.weekday)
      ? [...observed].filter((d) => weekdayInTz(`${d}T12:00:00Z`, tz) === st.weekday).length
      : observed.size;
    const hits = it
      ? (st.cadence === "weekly" && Number.isFinite(st.weekday)
        ? [...it.days.keys()].filter((d) => weekdayInTz(`${d}T12:00:00Z`, tz) === st.weekday).length
        : it.days.size)
      : 0;
    const verdict = checkContradiction(st, { observed: hits, opportunities, now, tz });
    if (verdict.contradicted) conflicts.push({ statement: st, ...verdict });
  }

  observations.sort((a, b) => b.confidence.value - a.confidence.value || (a.p ?? 1) - (b.p ?? 1) || a.id.localeCompare(b.id));
  suppressed.sort((a, b) => String(a.reason).localeCompare(String(b.reason))
    || String(a.item ?? "").localeCompare(String(b.item ?? ""))
    || (a.weekday ?? -1) - (b.weekday ?? -1));
  changepoints.sort((a, b) => String(a.item).localeCompare(String(b.item)) || String(a.level).localeCompare(String(b.level)));
  return {
    observations, suppressed, changepoints, conflicts,
    meta: { tz, from, to: today, days: rows.length ? new Set(rows.map((r) => r.dayKey)).size : 0, events: rows.length, items: items.size, tested: weekdayCands.length },
  };
}

function buildObservation(c, { tz, now, changepoints, statements, suppressed }) {
  const it = c.it;
  const stated = statements.some((s) => (s.itemKey || s.subject) === it.label && (!Number.isFinite(s.weekday) || s.weekday === c.weekday));
  const conf = resolveConfidence({ stated, support: c.cell.s, coverage: c.cell.coverage });
  const cp = changepoints.find((x) => x.item === it.label && x.level === it.level) || null;

  // HOUR SPLIT, run CONDITIONALLY inside an already-significant cell. It is a
  // nested refinement of a finding, not another member of the discovery family,
  // so it costs no multiplicity budget - which is the only reason a 44-day
  // sample can afford "day AND hour-by-hour" at all.
  let hour = null;
  if (c.onDay) {
    const evs = c.onDay.flatMap((d) => it.days.get(d) || []);
    const minutes = evs.map((e) => e.minute);
    const bands = new Map();
    for (const e of evs) bands.set(e.band, (bands.get(e.band) || 0) + 1);
    const [band, bandS] = [...bands.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const bandCover = wilsonLowerBound(bandS, evs.length, PE_COVERAGE_Z);
    const median = spCircularMedian(minutes);
    if (bandS >= PE_MIN_SUPPORT && bandCover >= PE_COVERAGE_FLOOR) {
      hour = { band, support: bandS, of: evs.length, medianMinute: median, at: hhmm(median), coverage: Number(bandCover.toFixed(4)) };
    } else if (suppressed) {
      suppressed.push({ reason: "hour_split_below_floor", item: it.label, weekday: c.weekday ?? null, weekdayName: c.kind === "weekday" ? WEEKDAY_NAMES[c.weekday] : null, band, s: bandS, of: evs.length, coverage: Number(bandCover.toFixed(4)), medianMinute: median });
    }
  }

  const shift = cp ? { type: cp.shift, proposesPlanChange: cp.proposesPlanChange } : { type: "none", proposesPlanChange: false };
  return {
    id: `${it.id}#${c.kind}${c.kind === "weekday" ? `:${c.weekday}` : ""}`,
    kind: c.kind, item: it.label, level: it.level, domain: it.domain,
    weekday: c.kind === "weekday" ? c.weekday : null,
    weekdayName: c.kind === "weekday" ? WEEKDAY_NAMES[c.weekday] : null,
    s: c.cell.s, W: c.cell.W, kTotal: c.cell.kTotal, weeks: c.cell.weeks,
    rate: Number(c.cell.rate.toFixed(4)), lift: Number(c.cell.lift.toFixed(2)), p: c.p,
    hour, confidence: conf,
    changepoint: cp ? { cutKey: cp.cutKey, cutDaysAgo: cp.cutDaysAgo, p: cp.p, direction: cp.direction, incumbent: cp.incumbent } : null,
    shift: shift.type,
    // The ONLY field that may ever lead to a plan edit, and it is a PROPOSAL: it
    // still has to travel the normal confirm gate. There is deliberately no
    // privileged write path out of this module and no `tool` key anywhere in
    // this return value - a test asserts that.
    proposesPlanChange: shift.proposesPlanChange && conf.mayWrite,
    planEdits: [],
    evidence: evidenceLine(c, hour),
    windowFrom: c.cut,
  };
}

// ===========================================================================
// 8. COPY - invariants are unit-tested, because this is the only part the user
//    ever reads and a wrong sentence is worse than silence
// ===========================================================================

// "every" is a universal claim. It may only appear when the item happened on
// EVERY observed opportunity and there were at least 4 of them - 3/3 is true and
// still too thin a thing to call "every".
const MAY_SAY_EVERY = (s, W) => s === W && s >= 4;
// Word-boundary, not substring: `\bshould\b` must not fire on "shoulder press",
// which is a real row in workout_logs.
const BANNED_WORDS = /\b(should|shouldn|bad|unhealthy|cheat|cheating)\b/i;

function evidenceLine(c, hour) {
  const { s, W } = c.cell;
  if (c.kind === "daily") return `${s} of the last ${W} logged days`;
  const day = `${WEEKDAY_NAMES[c.weekday]}s`;
  const core = MAY_SAY_EVERY(s, W) ? `every one of the last ${W} ${day}` : `${s} of the last ${W} ${day}`;
  return hour ? `${core}, usually around ${hour.at}` : core;
}

// The pre-emptive sentence. Retrospective phrasing ("you had pizza again last
// Saturday") is indistinguishable from nagging and was ruled out on purpose.
export function patternSentence(obs) {
  if (!obs) return "";
  const label = String(obs.item).replace(/^~/, "");
  const head = label.charAt(0).toUpperCase() + label.slice(1);
  // `evidence` already carries the time when there is one - do not append it a
  // second time. "usually around 20:10 ... Same around 20:10 today?" is the kind
  // of sentence that makes a user stop reading the notifications.
  if (obs.kind === "daily") return `${head} shows up ${obs.evidence}.`;
  return `${head}: ${obs.evidence}. Same today?`;
}

export function checkCopy(text) {
  const s = String(text || "");
  const problems = [];
  if (!/\d/.test(s)) problems.push("no_digit");
  if ((s.match(/\?/g) || []).length > 1) problems.push("multiple_questions");
  if (BANNED_WORDS.test(s)) problems.push("judgement_word");
  if (/\bevery\b/i.test(s) && !/\bevery one of the last (\d+)/i.test(s)) problems.push("unearned_every");
  return { ok: problems.length === 0, problems };
}

// ===========================================================================
// 9. NUDGE POLICY - a nudge must earn its channel
// ===========================================================================

export function planNudges(observations, ctx = {}) {
  const tz = ctx.tz || DEFAULT_TZ;
  const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now || 0);
  const today = dayKeyInTz(now, tz);
  const wdToday = weekdayInTz(now, tz);
  const quiet = ctx.quietHours || { start: 22, end: 7 };
  const feedback = ctx.feedback || {};
  const nudges = [];
  const skipped = [];
  let dayBudget = 1 - (ctx.sentToday || 0);
  let weekBudget = 2 - (ctx.sentThisWeek || 0);

  for (const obs of [...(observations || [])].sort((a, b) => b.confidence.value - a.confidence.value)) {
    const skip = (reason, extra) => skipped.push({ id: obs.id, reason, ...extra });
    if (obs.kind !== "weekday" || obs.weekday !== wdToday) { skip("not_today"); continue; }
    const fb = feedback[obs.id] || {};
    if ((fb.dismissals || 0) >= 2) { skip("muted_permanently", { dismissals: fb.dismissals }); continue; }
    if (fb.mutedUntil && fb.mutedUntil > today) { skip("muted", { until: fb.mutedUntil }); continue; }
    // Earning the channel: after 3 fires, if the Wilson LOWER bound on the act
    // rate is under 15%, this message is not working. Lower bound, not the raw
    // rate, so 0 of 3 mutes and 2 of 3 survives.
    if ((fb.fired || 0) >= 3 && wilsonLowerBound(fb.acted || 0, fb.fired, PE_COVERAGE_Z) < 0.15) {
      skip("low_act_rate_muted_28d", { acted: fb.acted || 0, fired: fb.fired, mutedUntil: addDays(today, 28) });
      continue;
    }
    if (!obs.hour) { skip("no_time_of_day"); continue; }
    // ~2h BEFORE the usual time, clamped to civil hours.
    let minute = Math.max(7 * 60 + 30, Math.min(21 * 60 + 30, obs.hour.medianMinute - 120));
    const h = Math.floor(minute / 60);
    const inQuiet = quiet.start > quiet.end ? (h >= quiet.start || h < quiet.end) : (h >= quiet.start && h < quiet.end);
    if (inQuiet) { skip("quiet_hours", { at: hhmm(minute) }); continue; }
    if (dayBudget <= 0) { skip("daily_cap"); continue; }
    if (weekBudget <= 0) { skip("weekly_cap"); continue; }
    const text = patternSentence(obs);
    const copy = checkCopy(text);
    if (!copy.ok) { skip("copy_invariant", copy); continue; }
    dayBudget -= 1; weekBudget -= 1;
    nudges.push({ id: obs.id, dayKey: today, atMinute: minute, at: hhmm(minute), text, evidence: obs.evidence, confidence: obs.confidence.value });
  }
  return { nudges, skipped };
}

export default {
  detectPatterns, planNudges, gateCell, detectChangepoint, classifyShift,
  resolveConfidence, checkContradiction, patternSentence, checkCopy,
  wilsonLowerBound, wilsonUpperBound, binomialUpperTail, fisherExactGreater,
  benjaminiHochberg, identityOf, sameItem, trigramJaccard,
};
