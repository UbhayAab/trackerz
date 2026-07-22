// Recurring-spend pattern learning. The owner's real, repeated lunch - "Rs 110
// for the same 3 eggs and 2 rotis, around midday" - logged three different ways
// must cluster into ONE pattern, and a fresh unpriced capture of it must get the
// Rs 110 suggestion WITH evidence. The defining guard: no guess without support,
// and never a suggestion over an amount the user already stated.
import assert from "node:assert/strict";
import {
  detectPatterns, suggestForCapture,
  spTokens, spDice, spMode, spSupportScore, spAmountAgreement,
  spCircularMedian, spCircularDelta, SP_MIN_SUPPORT,
} from "../lib/spend-patterns.mjs";

const TZ = "Asia/Kolkata";
// 13:00 IST == 07:30 UTC. Build midday-IST timestamps for a given date.
function middayIst(dateKey, hhmmIst = "13:00") {
  const [h, m] = hhmmIst.split(":").map(Number);
  const utcH = h - 5, utcM = m - 30; // IST = UTC+5:30
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCHours(utcH, utcM, 0, 0);
  return d.toISOString();
}

let ing = 0;
// One capture => a paired food row + ledger row sharing an ingestion id.
function pricedMeal(dateKey, desc, amount, hhmm = "13:00") {
  const id = `ing-${ing++}`;
  const at = middayIst(dateKey, hhmm);
  return [
    { id: `f-${id}`, ingestion_id: id, table: "food_logs", occurred_at: at, description: desc },
    { id: `l-${id}`, ingestion_id: id, table: "ledger_entries", direction: "expense", occurred_at: at, amount, description: desc },
  ];
}

// ---- token + similarity primitives ----
{
  const a = spTokens("Egg curry roti with 3 eggs");
  assert.ok(a.has("egg"), "eggs singularised to egg");
  assert.ok(a.has("roti"), "rotis singularised to roti");
  assert.ok(!a.has("with") && !a.has("3"), "stopwords + digits dropped");

  // The three real phrasings must overlap enough to cluster.
  const s1 = spTokens("Egg curry roti with 3 eggs");
  const s2 = spTokens("2 rotis and 3 eggs");
  const s3 = spTokens("rice and 3 eggs");
  assert.ok(spDice(s1, s2) >= 0.4, `egg/roti phrasings cluster: ${spDice(s1, s2)}`);
  assert.ok(spDice(s1, s3) >= 0.4, `egg phrasings cluster: ${spDice(s1, s3)}`);
  // A totally different meal must not.
  assert.ok(spDice(s1, spTokens("coffee and cookies")) < 0.4, "unrelated meal stays out");
}

// ---- mode never invents an unpaid amount ----
{
  // mean(110,110,110,120)=112.5 which was never paid; mode must be 110.
  const { value } = spMode([110, 110, 110, 120]);
  assert.equal(value, 110, "mode returns an actually-paid amount, not the mean");
}

// ---- support + agreement monotonicity ----
{
  assert.equal(spSupportScore(2, SP_MIN_SUPPORT), 0, "below floor scores zero");
  assert.ok(spSupportScore(3, 3) < spSupportScore(6, 3), "more observations -> more support");
  assert.ok(spAmountAgreement([110, 110, 110, 110]) > spAmountAgreement([110, 90, 130, 200]),
    "tighter amounts -> higher agreement");
}

// ---- circular time median wraps midnight ----
{
  assert.equal(spCircularDelta(23 * 60 + 50, 10), 20, "23:50 and 00:10 are 20 min apart");
  const med = spCircularMedian([23 * 60 + 50, 0, 10]);
  assert.ok(spCircularDelta(med, 0) <= 20, `midnight-straddling median stays near midnight: ${med}`);
}

// ---- THE headline case: the owner's Rs 110 lunch ----
const history = [
  ...pricedMeal("2026-07-01", "Egg curry roti with 3 eggs", 110, "12:45"),
  ...pricedMeal("2026-07-05", "2 rotis and 3 eggs", 110, "13:10"),
  ...pricedMeal("2026-07-12", "rice and 3 eggs, spent", 110, "12:30"),
  ...pricedMeal("2026-07-18", "egg curry and 2 roti", 120, "13:20"),
  // Noise that must NOT join the lunch cluster.
  ...pricedMeal("2026-07-03", "cold coffee at cafe", 180, "17:30"),
  ...pricedMeal("2026-07-09", "cold coffee", 180, "18:00"),
];

const patterns = detectPatterns(history, { timeZone: TZ });
const lunch = patterns.find((p) => p.tokens.includes("egg"));
assert.ok(lunch, "detected the recurring egg/roti lunch");
assert.equal(lunch.observations, 4, "all four egg/roti sightings clustered");
assert.equal(lunch.amount, 110, "typical amount is the paid Rs 110, not a Rs 112.5 average");
assert.equal(lunch.amountModeCount, 3, "110 seen on 3 of the 4");
assert.equal(lunch.firstSeen, "2026-07-01");
assert.equal(lunch.lastSeen, "2026-07-18");
assert.ok(lunch.spanDays >= 17, "date range recorded so confidence is earned");
assert.ok(lunch.typicalTime >= "12:00" && lunch.typicalTime <= "14:00", `midday: ${lunch.typicalTime}`);
assert.ok(lunch.confidence > 0.5 && lunch.confidence <= 1, `earned confidence: ${lunch.confidence}`);
assert.ok(lunch.examples.length >= 1 && lunch.examples.every((e) => typeof e === "string"),
  "carries the raw captures as evidence");

// The coffee is its own two-sighting run - below support, so NOT a pattern.
assert.ok(!patterns.some((p) => p.tokens.includes("coffee")), "2x coffee is not yet a pattern");

// ---- suggestForCapture: the payoff ----
{
  // A new midday capture that names the meal but no price.
  const s = suggestForCapture("had 3 eggs and 2 rotis", patterns, {
    now: middayIst("2026-07-21", "13:00"), timeZone: TZ,
  });
  assert.ok(s, "suggests for a matching unpriced capture");
  assert.equal(s.amount, 110, "suggests the paid amount");
  assert.equal(s.currency, "INR");
  assert.equal(s.action, "confirm_expense", "an offer to tap, not an applied write");
  assert.match(s.evidence, /Rs 110/, "evidence names the amount");
  assert.match(s.evidence, /4 times/, "evidence names the observation count");
  assert.match(s.evidence, /3 days ago/, "evidence names recency (last seen 07-18, now 07-21)");
  assert.ok(Array.isArray(s.matchedTokens) && s.matchedTokens.includes("egg"), "shows what matched");
  assert.ok(s.confidence >= 0.45, `cleared the suggest floor: ${s.confidence}`);
}

// ---- guardrails: every path that must return null ----
{
  // (a) amount already stated -> never override the user.
  assert.equal(
    suggestForCapture("had 3 eggs and 2 rotis paid 90", patterns, { now: middayIst("2026-07-21"), timeZone: TZ }),
    null, "no suggestion when the user stated a price",
  );
  // (b) no dish named.
  assert.equal(
    suggestForCapture("had lunch", patterns, { now: middayIst("2026-07-21"), timeZone: TZ }),
    null, "no suggestion for a bare meal slot",
  );
  // (c) unrelated food -> signature does not match.
  assert.equal(
    suggestForCapture("bowl of maggi noodles", patterns, { now: middayIst("2026-07-21"), timeZone: TZ }),
    null, "no suggestion for an unrelated dish",
  );
  // (d) weak support -> two coffees never yield a suggestion.
  assert.equal(
    suggestForCapture("cold coffee", patterns, { now: middayIst("2026-07-21", "17:30"), timeZone: TZ }),
    null, "no suggestion below the support floor",
  );
  // (e) stale pattern -> a price not seen in months is not offered.
  assert.equal(
    suggestForCapture("had 3 eggs and 2 rotis", patterns, { now: middayIst("2026-11-01"), timeZone: TZ }),
    null, "no suggestion once the pattern goes stale",
  );
}

// ---- data-fault: a spend row with a non-numeric amount must throw, not read 0 ----
{
  assert.throws(
    () => detectPatterns([{ table: "ledger_entries", direction: "expense", occurred_at: middayIst("2026-07-01"), amount: "oops", description: "x" }], { timeZone: TZ }),
    /non-numeric amount/, "a broken amount is a visible error, never a silent zero",
  );
}

// ---- empty / thin history yields no patterns and no suggestion (not a crash) ----
{
  assert.deepEqual(detectPatterns([], { timeZone: TZ }), [], "empty history -> no patterns");
  assert.equal(
    suggestForCapture("had 3 eggs and 2 rotis", [], { now: middayIst("2026-07-21"), timeZone: TZ }),
    null, "no patterns -> no suggestion",
  );
}

console.log("spend-patterns tests passed: Rs 110 lunch learned, suggested with evidence, and every no-support path returns null");
