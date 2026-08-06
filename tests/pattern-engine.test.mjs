// PATTERN ENGINE tests. The adversarial cases ARE the point: this module's job
// is to shut up, and only the negative tests can prove it does.
//
// The sample it has to survive (live DB, 2026-08-06): 77 food rows over 44 days,
// 18 workouts over 39 days, six Sundays in the whole history. Almost every cell
// must come back silent WITH A REASON.
import assert from "node:assert/strict";
import {
  detectPatterns, planNudges, patternSentence, checkCopy, gateCell, detectChangepoint,
  classifyShift, resolveConfidence, checkContradiction, identityOf, sameItem,
  trigramJaccard, wilsonInterval, wilsonLowerBound, wilsonUpperBound,
  binomialUpperTail, fisherExactGreater, benjaminiHochberg, lgamma, logChoose,
  bandForHour, PE_MIN_SUPPORT, PE_COVERAGE_Z, PE_CHANGEPOINT_ALPHA, PE_BH_Q, CONFIDENCE,
} from "../lib/pattern-engine.mjs";
import { categoryChainOf } from "../lib/food-nutrition.mjs";
import { dayKeyInTz, weekdayInTz } from "../lib/tz.mjs";

const TZ = "Asia/Kolkata";
let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const ok = (v, m) => { assert.ok(v, m); checks += 1; };
const close = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`); checks += 1; };

// An instant at a given IST wall clock on a given IST day.
const ist = (day, h, m = 0) => new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 + m - 330) * 60000).toISOString();
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); // tz-allowlist: UTC-midnight key arithmetic
const NOW = new Date(Date.parse("2026-08-02T04:00:00Z")); // Sunday 2 Aug 2026, 09:30 IST

// A background of ordinary logged days, so `W` (opportunities) is real.
function background(fromDay, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = shift(fromDay, i);
    out.push({ at: ist(d, 8, 30), kind: "food", description: "2 boiled eggs" });
    out.push({ at: ist(d, 13, 15), kind: "food", description: "3 rotis dal sabzi" });
  }
  return out;
}
const run = (events, extra = {}, opts = {}) => detectPatterns({ events, ...extra }, { now: NOW, tz: TZ, ...opts });
const weekdayObs = (out, item) => out.observations.filter((o) => o.kind === "weekday" && (!item || o.item === item));
const reasonsFor = (out, item) => out.suppressed.filter((s) => s.item === item).map((s) => s.reason);

// ===========================================================================
// 1. THE STATISTICS - implemented, not approximated
// ===========================================================================
close(lgamma(6), Math.log(120), 1e-9, "lgamma(6) = log(5!)");
close(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9, "lgamma(1/2) = log(sqrt(pi)), the reflection branch");
close(Math.exp(logChoose(8, 3)), 56, 1e-9, "C(8,3) = 56");
close(Math.exp(logChoose(90, 45)) / 1.03827e26, 1, 1e-4, "C(90,45) = 1.038e26 survives log space - a naive factorial form overflows to Infinity/Infinity = NaN, which compares false against every threshold and so fails SILENTLY as 'no pattern'");

close(binomialUpperTail(2, 2, 1 / 7), (1 / 7) ** 2, 1e-15, "P(X>=2 | n=2) = (1/7)^2 = 0.020408");
close(binomialUpperTail(4, 4, 1 / 7), 4.1649e-4, 1e-8, "4 consecutive Saturdays: p = 4.16e-4");
eq(binomialUpperTail(0, 5, 1 / 7), 1, "P(X>=0) = 1");
eq(binomialUpperTail(6, 5, 1 / 7), 0, "P(X>=k) = 0 when k > n");

// WHY WILSON AND NOT WALD, as a number.
{
  const p = 1, n = 4;
  const waldHalfWidth = 1.2816 * Math.sqrt((p * (1 - p)) / n);
  eq(waldHalfWidth, 0, "Wald's interval at 4/4 has ZERO width - it claims certainty from four data points");
  const w = wilsonInterval(4, 4, PE_COVERAGE_Z);
  close(w.lo, 0.7089, 1e-4, "Wilson lower bound at 4/4 is 0.709, not 1.0");
  ok(w.hi <= 1, "and it never exceeds 1");
}

// Fisher exact, one-sided.
close(fisherExactGreater(3, 0, 0, 14), 1 / 680, 1e-12, "3/3 new vs 0/14 prior = 1/C(17,3)");
close(fisherExactGreater(2, 0, 0, 14), 1 / 120, 1e-12, "2/2 new vs 0/14 prior = 1/C(16,2)");
ok(fisherExactGreater(5, 5, 5, 5) > 0.5, "a table with no signal is not significant");
eq(fisherExactGreater(0, 0, 0, 0), 1, "an empty table proves nothing");
ok(fisherExactGreater(0, 5, 5, 0) > 0.9, "and the reversed direction is not significant either");

// Benjamini-Hochberg at q = 0.10.
{
  const ps = [0.001, 0.008, 0.04, 0.2, 0.6];
  const keep = benjaminiHochberg(ps, 0.1);
  // thresholds are (i/m)*q = 0.02, 0.04, 0.06, 0.08, 0.10; largest i with p<=t is i=3 (0.04<=0.06)
  assert.deepEqual(keep, [true, true, true, false, false], "BH rejects the first three");
  checks += 1;
  assert.deepEqual(benjaminiHochberg([], 0.1), [], "empty family");
  assert.deepEqual(benjaminiHochberg([0.5], 0.1), [false], "a lone weak p stays weak");
  checks += 2;
}

// WHY NOT BONFERRONI - the disqualifying arithmetic, asserted rather than asserted-in-prose.
{
  const family = 40 * 7;                       // 40 tracked items x 7 weekdays
  const bonferroni = 0.05 / family;
  close(bonferroni, 1.7857e-4, 1e-8, "Bonferroni threshold at 280 cells is 1.79e-4");
  const fourSaturdays = binomialUpperTail(4, 4, 1 / 7);
  ok(fourSaturdays > bonferroni, "4 consecutive Saturdays (p = 4.16e-4) would be SUPPRESSED by Bonferroni - it kills the exact case that was asked for");
  ok(benjaminiHochberg([fourSaturdays], PE_BH_Q)[0], "BH keeps it");
}

// WHY NOT CHI-SQUARE.
close(6 / 7, 0.857, 1e-3, "expected count per weekday at k=6 is 0.86, an order of magnitude under chi-square's validity floor of 5");

// ===========================================================================
// 2. THE GATE TABLE - every case worked, both directions
// ===========================================================================
// kTotal = s in all of these (the item occurs ONLY on the target weekday), which
// is what makes the specificity column (1/7)^s.
const GATES = [
  // s, W, fires, lower bound, the gate that decided
  [3, 3, true, 0.6463, null],
  [4, 4, true, 0.7089, null],
  [4, 5, true, 0.5135, null],   // the tightest pass: 0.5135 vs a floor of 0.50
  [5, 6, true, 0.5747, null],
  [6, 7, true, 0.6223, null],
  [6, 8, true, 0.5237, null],
  [1, 1, false, 0.3784, "support_below_floor"],
  [2, 2, false, 0.5491, "support_below_floor"],
  [3, 4, false, 0.4325, "coverage_below_floor"],
  [3, 6, false, 0.2682, "coverage_below_floor"],
  [4, 6, false, 0.4094, "coverage_below_floor"],
  [5, 8, false, 0.4028, "coverage_below_floor"],
];
for (const [s, W, fires, lb, why] of GATES) {
  const g = gateCell({ s, W, kTotal: s, weeks: Math.min(s, W), dObserved: W });
  close(g.coverage, lb, 5e-4, `Wilson LB at ${s}/${W}`);
  eq(g.pass, fires, `gate ${s}/${W} must ${fires ? "FIRE" : "stay silent"} (LB ${g.coverage.toFixed(4)}, p ${g.p.toExponential(3)}, lift ${g.lift})`);
  if (!fires) eq(g.failures[0], why, `${s}/${W} must die at ${why}`);
}

// THE 2/2 TRAP, which is why the SUPPORT floor is the gate and not the p-value.
{
  const g = gateCell({ s: 2, W: 2, kTotal: 2, weeks: 2, dObserved: 2 });
  close(g.p, 0.020408, 1e-6, "2 of 2 Saturdays has p = 0.0204");
  ok(g.p < 0.05, "which PASSES a naive p < 0.05 - two coincidences look significant against a 1/7 null");
  ok(!g.pass, "and it still must not fire");
  eq(g.failures[0], "support_below_floor", "the support floor did the work, not the p-value");
  ok(g.coverage > 0.5, "note the coverage gate would have let it through too (LB 0.549) - support is the ONLY thing standing between the user and a two-point pattern");
}

// ===========================================================================
// 3. ITEM IDENTITY - three layers, layer 1 authoritative
// ===========================================================================
{
  eq(identityOf("2 slices of pizza").keys[0], "pizza slice", "LAYER 1: alias lookup resolves the dish");
  assert.deepEqual(identityOf("2 slices of pizza").categories, ["fastfood", "indulgence"], "and its category chain");
  checks += 1;
  // The owner's own worked example was unmatchable before this change.
  ok(identityOf("ice cream").keys.includes("ice cream"), "ice cream is now in the food vocabulary - `grep -c \"ice cream\" lib/food-nutrition.mjs` returned 0 on 2026-08-06, so the flagship example could not have been detected at all");
  assert.deepEqual(categoryChainOf("ice cream"), ["dessert", "indulgence"], "and it rolls up to indulgence");
  checks += 1;

  // LAYER 3 must never overrule LAYER 1. 0.30 would have merged these.
  close(trigramJaccard("chai", "chaat"), 0.375, 1e-6, "padded trigram J(chai, chaat) = 0.375 - a 0.30 threshold collides a tea habit with a street-snack habit");
  ok(trigramJaccard("chai", "chaat") < 0.6, "0.60 does not");
  eq(sameItem("chai", "fruit chaat").same, false, "and the table settles it regardless");
  eq(sameItem("chai", "fruit chaat").layer, 1, "at layer 1");
  eq(sameItem("2 slices of pizza", "pizza").same, true, "same dish, different words");

  // LAYER 2 and 3 only get a say when the table knows neither text.
  const a = identityOf("incline dumbbell press");
  const b = identityOf("incline dumbbell presses");
  eq(a.tableResolved, false, "gym text is not in the food table");
  eq(sameItem(a, b).same, true, "and clusters by token overlap / trigram");
  ok([2, 3].includes(sameItem(a, b).layer), "at layer 2 or 3");
  eq(sameItem("incline dumbbell press", "barbell squat").same, false, "different lifts stay different");
}

// ===========================================================================
// 4. THE ADVERSARIAL CASES
// ===========================================================================

// ONE Saturday pizza fires nothing. This is the owner's explicit instruction.
{
  const out = run([...background("2026-07-06", 28), { at: ist("2026-08-01", 20, 10), kind: "food", description: "2 slices of pizza" }]);
  eq(weekdayObs(out, "pizza slice").length, 0, "one pizza is not a pattern");
  eq(weekdayObs(out, "indulgence").length, 0, "and not at category level either");
  ok(reasonsFor(out, "pizza slice").includes("support_below_floor"), "and the silence is explained");
}

// TWO pizzas five weeks apart fire nothing - and the p-value WOULD have passed.
{
  const out = run([...background("2026-06-22", 42),
    { at: ist("2026-06-27", 20, 10), kind: "food", description: "2 slices of pizza" },
    { at: ist("2026-08-01", 20, 10), kind: "food", description: "2 slices of pizza" }]);
  eq(weekdayObs(out, "pizza slice").length, 0, "two Saturdays five weeks apart is not a pattern");
  const cell = out.suppressed.find((s) => s.item === "pizza slice" && s.weekday === 6);
  ok(cell, "the Saturday cell was evaluated and recorded");
  eq(cell.s, 2, "support 2");
  close(cell.p, 0.020408, 1e-6, "p = 0.0204, which passes a naive p < 0.05 - the FLOOR did the work, not the test");
  eq(cell.failures[0], "support_below_floor", "and it names which floor");
}

// THREE slices in one evening fire nothing: support counts DAYS, not rows.
{
  const out = run([...background("2026-07-06", 28),
    { at: ist("2026-08-01", 20, 0), kind: "food", description: "pizza slice" },
    { at: ist("2026-08-01", 20, 20), kind: "food", description: "pizza slice" },
    { at: ist("2026-08-01", 20, 40), kind: "food", description: "pizza slice" }]);
  eq(weekdayObs(out, "pizza slice").length, 0, "one binge is not a habit");
  const cell = out.suppressed.find((s) => s.item === "pizza slice" && s.weekday === 6);
  eq(cell.s, 1, "three rows on one day is support 1, not 3");
  eq(cell.weeks, 1, "and one ISO week, so the span floor holds it too");
}

// FOUR consecutive Saturdays fire. The flagship.
const SATS = ["2026-07-11", "2026-07-18", "2026-07-25", "2026-08-01"];
{
  const out = run([...background("2026-07-06", 28), ...SATS.map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))]);
  const p = weekdayObs(out, "pizza slice")[0];
  ok(p, "four consecutive Saturdays IS a pattern");
  eq(p.weekdayName, "Saturday", "on Saturday");
  eq(p.s, 4, "s = 4"); eq(p.W, 4, "W = 4");
  close(p.p, 4.1649e-4, 1e-8, "p = 4.16e-4");
  close(p.confidence.value, 0.7089, 1e-4, "confidence is the Wilson lower bound, 0.709 - NOT 1.0");
  eq(p.confidence.tier, "OBSERVED", "tier OBSERVED");
  // The hour half of "day AND hour-by-hour", run conditionally INSIDE the cell.
  ok(p.hour, "the hour split resolved");
  eq(p.hour.band, "dinner", "dinner");
  eq(p.hour.at, "20:10", "circular median 20:10");
  // Subsumption: one fact, said once.
  eq(weekdayObs(out).length, 1, "pizza slice / fastfood / indulgence are ONE fact - the user hears the sharpest version once");
  ok(out.suppressed.some((s) => s.reason === "subsumed_by_more_specific" && s.item === "indulgence"), "the rollups say why they went quiet");
}

// A HOLIDAY WEEK WITH NO DATA does not break a 4/4 pattern.
{
  const events = [...background("2026-07-06", 28).filter((e) => {
    const d = dayKeyInTz(e.at, TZ);
    return !(d >= "2026-07-13" && d <= "2026-07-19");   // a week with zero logs
  })];
  const sats = ["2026-07-11", "2026-07-25", "2026-08-01"];
  // plus one more Saturday before the gap so support is still 4
  const out = run([...events, ...["2026-07-04", ...sats].map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" })),
    { at: ist("2026-07-04", 13, 15), kind: "food", description: "3 rotis dal sabzi" }]);
  const p = weekdayObs(out, "pizza slice")[0];
  ok(p, "the pattern survives a week of silence");
  eq(p.s, 4, "s = 4");
  eq(p.W, 4, "W = 4 - an unlogged Saturday is NOT an opportunity the user declined, it is a Saturday we know nothing about");
}

// A DAILY item makes no weekday claim.
{
  const out = run(background("2026-07-06", 28));
  const egg = out.observations.find((o) => o.item === "egg");
  ok(egg, "eggs every day is a pattern");
  eq(egg.kind, "daily", "of kind daily");
  eq(egg.weekday, null, "with no weekday");
  eq(egg.p, null, "and no weekday p-value - 'how surprising is this on a Tuesday' is meaningless for something that happens every day, and writing a number there is exactly the absent-data-as-measurement bug");
  eq(weekdayObs(out, "egg").length, 0, "no weekday observation at all");
  ok(out.suppressed.some((s) => s.item === "egg" && s.reason === "daily_item_no_weekday_claim"), "explained");
  // Lift is the mechanism, independent of the daily short-circuit.
  const g = gateCell({ s: 4, W: 4, kTotal: 28, weeks: 4, dObserved: 28 });
  close(g.lift, 1, 1e-9, "a daily item's weekday lift is exactly 1.0");
  ok(g.failures.includes("lift_below_floor"), "so the lift gate would have killed it anyway");
}

// CATEGORY RESCUES A SPLIT KEY - the flagship requirement in its real form.
{
  const out = run([...background("2026-07-06", 28),
    { at: ist("2026-07-11", 20, 10), kind: "food", description: "2 slices of pizza" },
    { at: ist("2026-07-18", 20, 10), kind: "food", description: "2 slices of pizza" },
    { at: ist("2026-07-25", 20, 10), kind: "food", description: "1 burger" },
    { at: ist("2026-08-01", 20, 10), kind: "food", description: "1 burger" }]);
  eq(weekdayObs(out, "pizza slice").length, 0, "pizza alone is s=2 - dead at the floor, correctly");
  eq(weekdayObs(out, "burger").length, 0, "burger alone is s=2 - dead too");
  ok(reasonsFor(out, "pizza slice").includes("support_below_floor"), "both explained");
  const cat = weekdayObs(out, "fastfood")[0];
  ok(cat, "but 'going out' is s=4 at category level and FIRES - without categories the owner's own example fails");
  eq(cat.s, 4, "s = 4"); eq(cat.level, "category", "at category level");
  eq(cat.weekdayName, "Saturday", "Saturday");
}

// ICE CREAM EVERY SUNDAY - the owner's second worked example, end to end.
{
  const suns = ["2026-07-12", "2026-07-19", "2026-07-26", "2026-08-02"];
  const out = run([...background("2026-07-06", 28), ...suns.map((d) => ({ at: ist(d, 21, 0), kind: "food", description: "ice cream" }))]);
  const o = weekdayObs(out, "ice cream")[0];
  ok(o, "ice cream every Sunday is detected");
  eq(o.weekdayName, "Sunday", "on Sunday");
  eq(o.hour.at, "21:00", "at 21:00");
}
// ...and ONE Sunday of ice cream is not, which is the sentence the owner
// actually stressed.
{
  const out = run([...background("2026-07-06", 28), { at: ist("2026-08-02", 21, 0), kind: "food", description: "ice cream" }]);
  eq(weekdayObs(out, "ice cream").length, 0, "just ONE Sunday of ice cream is NOT a pattern");
  eq(out.observations.filter((o) => o.item === "ice cream").length, 0, "not of any kind");
}

// ===========================================================================
// 5. CHANGEPOINTS - the fix for "for four days I ate well, then one pizza"
// ===========================================================================
{
  const observed = new Set();
  for (let i = 0; i < 21; i++) observed.add(shift("2026-07-13", i));   // 13 Jul .. 2 Aug
  const days = [...observed].sort();
  const latency = (n) => detectChangepoint(new Set(days.slice(-n)), observed, { now: NOW, tz: TZ });

  eq(latency(2), null, "2 new days is not a regime - one-off and two-off must stay invisible");
  const three = latency(3);
  ok(three, "3 new days against an established prior IS detected");
  eq(three.direction, "rose", "as a rise");
  eq(three.cutKey, "2026-07-31", "cut 3 days back");
  ok(three.p <= PE_CHANGEPOINT_ALPHA, `p ${three.p.toExponential(3)} clears the Bonferroni-over-19-cuts bar ${PE_CHANGEPOINT_ALPHA.toExponential(3)}`);
  ok(latency(4), "and 4 days certainly");

  // The honest edge: a SHORT prior needs more evidence. 4/4 against a 7-day
  // prior is 1/C(11,4) = 3.03e-3 and just misses; an 8-day prior is 2.02e-3.
  const short7 = [...Array(11)].map((_, i) => shift("2026-07-23", i));
  eq(detectChangepoint(new Set(short7.slice(-4)), new Set(short7), { now: NOW, tz: TZ }), null, "4/4 against a 7-day prior just misses (3.03e-3 vs 2.63e-3)");
  const short8 = [...Array(12)].map((_, i) => shift("2026-07-22", i));
  ok(detectChangepoint(new Set(short8.slice(-4)), new Set(short8), { now: NOW, tz: TZ }), "4/4 against an 8-day prior clears it (2.02e-3)");
  close(1 / Math.exp(logChoose(11, 4)), 3.0303e-3, 1e-7, "1/C(11,4)");
  close(1 / Math.exp(logChoose(12, 4)), 2.0202e-3, 1e-7, "1/C(12,4)");
}

// A DIET CHANGE FOUR DAYS AGO is detected, and the pattern window truncates to it.
{
  const events = [];
  for (let i = 0; i < 25; i++) {
    const d = shift("2026-07-09", i);
    events.push({ at: ist(d, 8, 30), kind: "food", description: "2 boiled eggs" });
    events.push({ at: ist(d, 13, 15), kind: "food", description: i < 21 ? "3 rotis dal sabzi" : "2 slices of pizza" });
  }
  const out = run(events);
  const rise = out.changepoints.find((c) => c.item === "pizza slice");
  ok(rise, "the switch is seen within 4 days, not six weeks");
  eq(rise.direction, "rose", "risen");
  eq(rise.cutDaysAgo, 4, "cut 4 days back");
  ok(rise.p < PE_CHANGEPOINT_ALPHA, "significantly");
  eq(rise.recent.hits, 4, "4 of the recent days");
  eq(rise.prior.hits, 0, "0 of the prior ones");
  ok(out.changepoints.some((c) => c.item === "dal" && c.direction === "fell"), "and the incumbent is seen to fall");

  // REPLACEMENT: the lunch slot changed hands.
  eq(rise.shift, "replacement", "newRose && oldFell = REPLACEMENT");
  eq(rise.incumbent, "dal", "with the incumbent named");
  eq(rise.proposesPlanChange, true, "a replacement MAY propose a plan change");
  assert.deepEqual(rise.planEdits, [], "but it still emits zero edits of its own - the proposal travels the normal confirm gate");
  checks += 1;
}

// ADDITION: pizza appears at dinner while lunch is untouched. Zero plan edits.
{
  const events = [];
  for (let i = 0; i < 25; i++) {
    const d = shift("2026-07-09", i);
    events.push({ at: ist(d, 13, 15), kind: "food", description: "3 rotis dal sabzi" });
    if (i >= 21) events.push({ at: ist(d, 20, 30), kind: "food", description: "2 slices of pizza" });
  }
  const out = run(events);
  const rise = out.changepoints.find((c) => c.item === "pizza slice");
  ok(rise, "the addition is still detected and reported");
  eq(rise.shift, "addition", "newRose && !oldFell = ADDITION");
  eq(rise.incumbent, null, "nothing was displaced");
  eq(rise.proposesPlanChange, false, "an ADDITION may NEVER propose a plan change");
  eq(out.changepoints.filter((c) => c.proposesPlanChange).length, 0, "zero proposals in the whole result");
  eq(out.changepoints.flatMap((c) => c.planEdits).length, 0, "and ZERO plan edits");
  eq(out.observations.flatMap((o) => o.planEdits).length, 0, "from observations too");
}

// classifyShift in isolation.
{
  const rose = { direction: "rose", p: 1e-4 };
  const fell = { direction: "fell", p: 1e-4 };
  eq(classifyShift(rose, fell).type, "replacement", "rose + fell");
  eq(classifyShift(rose, null).type, "addition", "rose alone");
  eq(classifyShift(rose, rose).type, "addition", "two rises is not a replacement");
  eq(classifyShift(fell, fell).type, "none", "a fall alone proposes nothing");
  eq(classifyShift(null, fell).proposesPlanChange, false, "and neither does nothing");
}

// ===========================================================================
// 6. CONFIDENCE HIERARCHY - precedence, not averaging
// ===========================================================================
{
  const stated = resolveConfidence({ stated: true, support: 2, coverage: 0.29 });
  eq(stated.tier, "STATED", "a user statement outranks a measurement");
  eq(stated.value, CONFIDENCE.STATED, "at 1.00");
  ok(stated.value !== (1 + 0.29) / 2, "NOT averaged with the observation - an instruction and a measurement are not two noisy readings of the same quantity");

  eq(resolveConfidence({ stated: true, contradicted: true, support: 2, coverage: 0.29 }).tier, "SINGLE", "only contradiction removes a stated fact");
  eq(resolveConfidence({ confirmed: true, support: 1 }).value, CONFIDENCE.CONFIRMED, "CONFIRMED = 0.90");
  eq(resolveConfidence({ support: 4, coverage: 0.7089 }).tier, "OBSERVED", "OBSERVED");
  eq(resolveConfidence({ support: 4, coverage: 0.7089 }).value, 0.7089, "carries the Wilson lower bound itself");
  const single = resolveConfidence({ support: 1, coverage: 0.9 });
  eq(single.tier, "SINGLE", "one sighting is SINGLE");
  eq(single.value, CONFIDENCE.SINGLE, "0.33");
  eq(single.mayWrite, false, "and it NEVER writes");
  eq(resolveConfidence({ support: PE_MIN_SUPPORT - 1, coverage: 0.99 }).mayWrite, false, "high coverage on thin support still never writes");
}

// THE CONTRADICTION BOUNDARY, at z = 1.6449 against a 0.60 ceiling.
{
  close(wilsonUpperBound(2, 7, 1.6449), 0.5913, 1e-4, "UB(2,7) = 0.591");
  close(wilsonUpperBound(3, 7, 1.6449), 0.7105, 1e-4, "UB(3,7) = 0.711");
  const said = { subject: "egg", cadence: "daily" };
  const two = checkContradiction(said, { observed: 2, opportunities: 7, now: NOW, tz: TZ });
  eq(two.contradicted, true, "2 of 7 CONTRADICTS 'I eat eggs every day' (0.591 < 0.60)");
  eq(two.askOnce, true, "ask once");
  eq(two.quietUntil, "2026-08-16", "then stay quiet 14 days");
  eq(two.options.length, 3, "three options");
  const gap = two.options.find((o) => o.id === "logging_gap");
  ok(gap, "the middle option exists");
  eq(gap.effect, "exclude_days_from_all_patterns", "and missing logs must be excludable from EVERY pattern, not just this one - they poison the denominator of all of them");
  eq(checkContradiction(said, { observed: 3, opportunities: 7, now: NOW, tz: TZ }).contradicted, false, "3 of 7 does NOT contradict - stay quiet");
  eq(checkContradiction(said, { observed: 0, opportunities: 0, now: NOW, tz: TZ }).contradicted, false, "and no data contradicts nothing");
}

// The stated/observed conflict, end to end, on the real "6 eggs daily" shape.
{
  const events = [];
  for (let i = 0; i < 7; i++) {
    const d = shift("2026-07-27", i);
    events.push({ at: ist(d, 13, 15), kind: "food", description: "3 rotis dal sabzi" });
    if (i < 2) events.push({ at: ist(d, 8, 30), kind: "food", description: "6 boiled eggs" });
  }
  const out = run(events, { stated: [{ subject: "egg", cadence: "daily", domain: "food" }] });
  eq(out.conflicts.length, 1, "the statement is contradicted by the logs");
  eq(out.conflicts[0].observed, 2, "2 of");
  eq(out.conflicts[0].opportunities, 7, "7 logged days");
  close(out.conflicts[0].upperBound, 0.5913, 1e-4, "UB 0.591");
}

// GAP DAYS - the middle option, honoured. Excluded from BOTH numerator and
// denominator, because leaving them in silently converts "I forgot" into "I skipped".
{
  const events = [...background("2026-07-06", 28), ...SATS.map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))];
  const base = run(events);
  const withGap = run(events, { gapDays: ["2026-07-18"] });
  eq(weekdayObs(base, "pizza slice")[0].s, 4, "4/4 with everything logged");
  const p = weekdayObs(withGap, "pizza slice")[0];
  eq(p.s, 3, "3 after excluding the unlogged Saturday");
  eq(p.W, 3, "and W drops to 3 as well - the day left the denominator too");
  ok(p, "3/3 still fires, correctly");
}

// ===========================================================================
// 7. THE ENGINE RETURNS OBSERVATIONS, NOT TOOL CALLS
// ===========================================================================
{
  const out = run([...background("2026-07-06", 28), ...SATS.map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))]);
  const keys = new Set();
  (function scan(v, depth = 0) {
    if (depth > 12 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x) => scan(x, depth + 1)); return; }
    for (const [k, val] of Object.entries(v)) { keys.add(k); scan(val, depth + 1); }
  })(out);
  ok(keys.size > 20, "the scan actually walked the result");
  for (const forbidden of ["tool", "tools", "tool_call", "tool_calls", "toolName", "arguments", "apply", "write"]) {
    eq(keys.has(forbidden), false, `the engine has NO privileged write path: key "${forbidden}" must not appear anywhere in its return value`);
  }
  ok(keys.has("observations") && keys.has("suppressed"), "it returns observations and its reasons for silence");
}

// ===========================================================================
// 8. COPY INVARIANTS
// ===========================================================================
{
  const out = run([...background("2026-07-06", 28), ...SATS.map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))]);
  const text = patternSentence(weekdayObs(out, "pizza slice")[0]);
  ok(/\d/.test(text), "every message contains a digit");
  ok(/4 Saturdays/.test(text), "and carries its own evidence");
  eq((text.match(/\?/g) || []).length, 1, "at most one question mark");
  eq(checkCopy(text).ok, true, `copy invariants hold: ${text}`);

  // "every" is a universal claim: only at s === W && s >= 4.
  ok(/every one of the last 4 Saturdays/.test(text), "4/4 earns the word 'every'");
  const three = run([...background("2026-07-13", 21), ...SATS.slice(1).map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))]);
  const t3 = patternSentence(weekdayObs(three, "pizza slice")[0]);
  eq(/\bevery\b/.test(t3), false, "3/3 is true and still does not earn 'every'");
  ok(/3 of the last 3 Saturdays/.test(t3), "it says 3 of 3 instead");

  // The banned vocabulary, and the word-boundary trap it hides.
  for (const bad of ["you should skip it", "that is a bad day", "unhealthy again", "cheat day"]) {
    eq(checkCopy(`4 of 5: ${bad}`).ok, false, `"${bad}" is rejected`);
  }
  eq(checkCopy("Shoulder press: 4 of the last 5 Fridays. Same today?").ok, true, "but 'shoulder' is a real workout_logs row and must survive the \\bshould\\b check");
  eq(checkCopy("Pizza on 4 Saturdays. Going out? Want the usual?").problems[0], "multiple_questions", "two questions is one too many");
  eq(checkCopy("Pizza every Saturday.").ok, false, "'every' without the earned form is rejected");
  eq(checkCopy("Pizza on Saturdays.").problems[0], "no_digit", "a message with no number is not evidence");
}

// ===========================================================================
// 9. NUDGE POLICY
// ===========================================================================
const SATURDAY = new Date(Date.parse("2026-08-08T04:00:00Z")); // Sat 8 Aug, 09:30 IST
{
  const events = [...background("2026-07-06", 28), ...SATS.map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))];
  const out = detectPatterns({ events }, { now: SATURDAY, tz: TZ });
  const obs = out.observations;

  const { nudges } = planNudges(obs, { now: SATURDAY, tz: TZ });
  eq(nudges.length, 1, "one nudge");
  eq(nudges[0].at, "18:10", "PRE-EMPTIVE: 2h before the 20:10 circular median, not after the fact");
  eq(nudges[0].dayKey, "2026-08-08", "on the day it matters");
  eq(checkCopy(nudges[0].text).ok, true, "and it passes the copy gate before it can be queued");

  // Not the right weekday -> nothing.
  eq(planNudges(obs, { now: NOW, tz: TZ }).nudges.length, 0, "no nudge on a Sunday for a Saturday pattern");
  eq(planNudges(obs, { now: NOW, tz: TZ }).skipped.some((s) => s.reason === "not_today"), true, "explained");

  // Caps.
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, sentToday: 1 }).nudges.length, 0, "<= 1 new push per day");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, sentThisWeek: 2 }).nudges.length, 0, "<= 2 per week");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, sentToday: 1 }).skipped.find((s) => s.reason === "daily_cap") !== undefined, true, "cap is reported");

  // Earning the channel.
  const id = nudges[0].id;
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { fired: 3, acted: 0 } } }).nudges.length, 0, "0 acted of 3 fired mutes it");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { fired: 3, acted: 1 } } }).nudges.length, 0, "1 of 3 too: wilsonLowerBound(1,3) = 0.106 < 0.15");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { fired: 3, acted: 2 } } }).nudges.length, 1, "2 of 3 survives: LB 0.321");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { fired: 2, acted: 0 } } }).nudges.length, 1, "and the rule needs 3 fires before it can judge");
  close(wilsonLowerBound(0, 3, PE_COVERAGE_Z), 0, 1e-3, "LB(0,3) ~ 0");
  close(wilsonLowerBound(2, 3, PE_COVERAGE_Z), 0.3212, 1e-3, "LB(2,3) = 0.321");
  const muted = planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { fired: 3, acted: 0 } } });
  eq(muted.skipped.find((s) => s.id === id).mutedUntil, "2026-09-05", "muted 28 days");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { dismissals: 2 } } }).skipped.find((s) => s.id === id).reason, "muted_permanently", "two explicit dismissals mute permanently");
  eq(planNudges(obs, { now: SATURDAY, tz: TZ, feedback: { [id]: { dismissals: 1 } } }).nudges.length, 1, "one dismissal does not");
}

// Quiet hours and the civil-hours clamp.
{
  const lateSats = SATS.map((d) => ({ at: ist(d, 6, 0), kind: "food", description: "2 slices of pizza" }));
  const out = detectPatterns({ events: [...background("2026-07-06", 28), ...lateSats] }, { now: SATURDAY, tz: TZ });
  const o = out.observations.find((x) => x.item === "pizza slice");
  ok(o, "a 06:00 habit is still a pattern");
  const { nudges } = planNudges([o], { now: SATURDAY, tz: TZ });
  eq(nudges[0].at, "07:30", "2h before 06:00 would be 04:00 - clamped up to 07:30");
  const q = planNudges([o], { now: SATURDAY, tz: TZ, quietHours: { start: 22, end: 8 } });
  eq(q.nudges.length, 0, "and quiet hours still win over the clamp");
  eq(q.skipped[0].reason, "quiet_hours", "explained");
}

// ===========================================================================
// 10. DETERMINISM, EMPTY INPUT, AND ALWAYS-EXPLAINED SILENCE
// ===========================================================================
{
  const events = [...background("2026-07-06", 28), ...SATS.map((d) => ({ at: ist(d, 20, 10), kind: "food", description: "2 slices of pizza" }))];
  const a = JSON.stringify(run(events));
  const b = JSON.stringify(run([...events].reverse()));
  eq(a, b, "a frozen `now` and the same rows give byte-identical output regardless of row order");

  const empty = run([]);
  eq(empty.observations.length, 0, "no events, no observations");
  eq(empty.suppressed[0].reason, "window_empty", "and the silence is still explained");

  // An unusable row is reported, never silently dropped. A quiet drop is how a
  // whole week of captures leaves a pattern while the engine reports confidently
  // on what is left.
  const bad = run([{ kind: "food", description: "pizza" }, { at: "not a date", kind: "food", description: "pizza" }]);
  ok(bad.suppressed.some((s) => s.reason === "event_without_timestamp"), "a row with no timestamp is on the record");
  ok(bad.suppressed.some((s) => s.reason === "event_timestamp_unparseable"), "and so is a row with a broken one");

  // Every cell that had ANY support and did not surface must be in suppressed[].
  const thin = run([...background("2026-07-06", 28),
    { at: ist("2026-07-18", 20, 10), kind: "food", description: "1 burger" },
    { at: ist("2026-07-25", 20, 10), kind: "food", description: "1 burger" }]);
  eq(weekdayObs(thin, "burger").length, 0, "2 Saturdays does not fire");
  const rec = thin.suppressed.find((s) => s.item === "burger" && s.weekday === 6);
  ok(rec, "and the cell is on the record");
  ok(rec.s !== undefined && rec.W !== undefined && rec.p !== undefined, "with its numbers, so the silence is debuggable");
  ok(thin.suppressed.every((s) => typeof s.reason === "string" && s.reason.length), "every suppression names a reason");
  ok(thin.meta.tested >= 0 && thin.meta.days === 28, "meta reports what was actually looked at");
}

// Timezone correctness inside the engine: a 23:30 IST Friday habit must be
// reported as FRIDAY, and the same instants read in UTC would say Friday too -
// so use 00:30 IST Saturday, where UTC and IST disagree.
{
  const nights = ["2026-07-12", "2026-07-19", "2026-07-26", "2026-08-02"]; // Sundays, 00:30 IST
  const out = run([...background("2026-07-06", 28), ...nights.map((d) => ({ at: ist(d, 0, 30), kind: "food", description: "ice cream" }))]);
  const o = weekdayObs(out, "ice cream")[0];
  ok(o, "a late-night habit is a pattern");
  eq(o.weekdayName, "Sunday", "reported on the IST day (Sunday), not the UTC one");
  for (const d of nights) eq(WEEKDAY_NAMES_UTC(ist(d, 0, 30)), "Saturday", "the UTC slice would have said Saturday - the off-by-one the user would have read in a sentence");
}
function WEEKDAY_NAMES_UTC(iso) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(iso).getUTCDay()];
}

// Meal bands come from the canonical mealSlotFromTime, not a second copy.
eq(bandForHour(8), "breakfast", "08:00 IST");
eq(bandForHour(13), "lunch", "13:00 IST");
eq(bandForHour(17), "snack", "17:00 IST");
eq(bandForHour(20), "dinner", "20:00 IST");
eq(weekdayInTz("2026-08-01T14:40:00Z", TZ), 6, "20:10 IST on 1 Aug is Saturday");

console.log(`pattern-engine tests passed (${checks} assertions)`);
