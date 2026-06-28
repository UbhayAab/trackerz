// CONSUMPTION-INTENT classifier: a food word no longer auto-implies "ate".
// A capture mentioning food can mean three very different things — the user ATE
// it, BOUGHT it (groceries / stock for later), or is describing a PLAN/target.
// This module splits those apart, detects gym free-text (even without the word
// "gym"), and parses set×rep×weight out of a workout description. Pure (no DOM,
// no Supabase) so it's tested directly; the edge function keeps an inline mirror.
//
// It reuses the already-proven looksLikeFood / mealSlotFromTime / extractAmount
// from fan-out-expander.mjs so there is one source of truth for food detection.

import { looksLikeFood, extractAmount } from "./fan-out-expander.mjs";

// ---- lexicons (exported so the index.ts mirror + tests share one source) ----

export const CONSUME_WORDS = [
  "ate", "eaten", "eating", "had", "having", "have a", "grabbed", "drank", "drinking",
  "downed", "finished", "ordered in", "ate out", "scarfed", "munched", "snacked",
  "consumed", "just had", "just ate", "for breakfast i had", "for lunch i had",
  "for dinner i had", "polished off", "gobbled", "chowed", "sipped", "wolfed",
];

export const BUY_WORDS = [
  "bought", "buy", "buying", "purchased", "picked up", "stocked", "stock up",
  "stocked up", "stocking", "groceries", "grocery", "grocery run", "ordered",
  "order", "restocked", "got from", "fridge", "pantry", "for the week", "for later",
  "for the month", "supplies", "loaf", "dozen", "carton", "pack of", "packet of",
  "kg of", "litre of", "liter of", "bag of", "crate of", "blinkit", "zepto",
  "instamart", "bigbasket", "dmart", "more supermarket", "reliance fresh",
];

export const GROCERY_WORDS = [
  "groceries", "grocery", "stock", "stocked", "pantry", "fridge", "for the week",
  "for the month", "for later", "supplies", "restock", "loaf", "dozen", "carton",
  "crate", "bag of", "pack of", "packet of", "kg of", "litre of", "liter of",
  "bigbasket", "dmart", "blinkit", "zepto", "instamart",
];

export const PLAN_WORDS = [
  "plan", "my plan", "meal plan", "template", "going to", "gonna", "will have",
  "tomorrow i will", "i should", "i want to eat", "plan to", "planning", "intend to",
  "my usual", "usual", "as per plan", "set my target", "target", "goal of", "aim to",
  "diet plan", "switch my plan", "update my plan", "change my plan",
];

export const USUAL_WORDS = [
  "did my usual", "my usual", "usual", "as planned", "as per plan",
  "stuck to the plan", "followed the plan", "the whole plan", "everything on plan",
  "on plan", "did the plan", "completed my plan",
];

export const GYM_WORDS = [
  "workout a", "workout b", "work out a", "work out b", "did legs", "leg day",
  "did chest", "chest day", "did back", "back day", "did push", "push day",
  "did pull", "pull day", "did shoulders", "did arms", "arm day", "gym",
  "gym session", "session", "trained", "training", "lifted", "lift",
  "did my workout", "worked out", "hit the gym", "leg press", "chest press",
  "bench", "bench press", "squat", "goblet squat", "deadlift", "romanian deadlift",
  "rdl", "lat pulldown", "cable row", "seated cable row", "leg curl",
  "leg extension", "shoulder press", "overhead press", "ohp", "lateral raise",
  "triceps pushdown", "pushdown", "db curl", "dumbbell curl", "bicep curl",
  "plank", "dead bug", "incline press", "incline db press", "machine chest press",
  "machine shoulder press",
];

export const CARDIO_WORDS = [
  "ran", "run", "running", "jog", "jogged", "jogging", "walked", "walk", "walking",
  "treadmill", "cycle", "cycled", "cycling", "elliptical", "steps", "10k steps",
  "cardio", "skipping", "jump rope", "swim", "swam", "brisk walk", "cooldown walk",
];

export const MEAL_SLOT_WORDS = [
  "breakfast", "brunch", "lunch", "snack", "evening snack", "dinner", "supper",
  "midnight snack", "pre-workout", "post-workout",
];

export const SUPPLEMENT_WORDS = [
  "b12", "vitamin b12", "d3", "vitamin d3", "omega", "omega 3", "fish oil",
  "magnesium", "mag", "psyllium", "isabgol", "fibre", "fiber", "whey",
  "protein powder", "creatine", "multivitamin", "supplement", "supplements",
];

export const WELLNESS_WORDS = [
  "sleep", "slept", "mood", "stress", "stressed", "anxious", "water", "hydration",
  "steps", "weight", "weighed", "meditat", "meditation", "energy", "rested",
];

// set×rep ("3x10", "3 × 10") and weight ("60kg", "60 kg", "@60kg") cues.
export const SET_REP_RE = /(\d+)\s*[x×]\s*(\d+)/i;
export const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(?:kg|kgs|lbs)\b/i;

// ---- helpers ----

function lc(text) {
  return String(text || "").toLowerCase();
}

// Multiword phrases are matched with includes (so "for the week" works); single
// tokens use a word boundary so "ate" never matches inside "skate".
function hasAny(t, words) {
  return words.some((w) => {
    if (/[^a-z0-9]/.test(w)) return t.includes(w); // phrase / has punctuation
    return new RegExp(`\\b${w}\\b`).test(t);
  });
}

// Negation / non-event frames around a food word: "no time for lunch", "out of
// milk", "skipped breakfast", "thinking about pizza". These must NOT read as eating.
const NEGATION_RE = /\b(?:no time for|skip(?:ped|ping)?|out of|no more|ran out of|missed|forgot to eat|craving|crave|thinking about|wish i had|want some|need to buy|low on)\b/;

// A "meal frame" is a meal-slot word used as a consumption context — "for lunch",
// "lunch ", a leading "lunch:" etc. Used both as an eat cue and to disambiguate.
function hasMealFrame(t) {
  if (NEGATION_RE.test(t)) return false;
  return MEAL_SLOT_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(t));
}

// ---- consumption intent ----

// Decide intent ONLY for food-context captures: 'ate' | 'bought' | 'plan' | 'none'.
// Precedence (see spec): plan beats buy/eat when no past/now eating verb; an
// explicit eat verb beats a buy word ("bought a sandwich and ate it" -> ate);
// buy/grocery with NO eat verb -> bought; a meal frame counts as an eat cue; an
// ambiguous bare food noun -> 'none' (caller keeps model output / routes review).
// A spend cue: an extractable amount or an explicit spend verb / currency mark.
// Paid-for food with NO grocery cue is a meal eaten out, not a grocery run.
const SPEND_RE = /\b(?:spent|paid|spend|cost|bill)\b|[₹$]|\b(?:rs|inr)\b/i;
// "ordered"/"order" is the one ambiguous buy word — a delivery order of a meal is
// eating; an order of groceries is a purchase. Handle it separately from hard buys.
const ORDERED_RE = /\border(?:ed)?\b/i;

export function classifyConsumption(text = "") {
  const t = lc(text);
  if (!t.trim()) return "none";

  const ate = hasAny(t, CONSUME_WORDS);
  const grocery = hasAny(t, GROCERY_WORDS);
  // Hard buy = a definite purchase word EXCEPT the ambiguous "ordered/order".
  const hardBuy = grocery || hasAny(t, BUY_WORDS.filter((w) => w !== "ordered" && w !== "order"));
  const ordered = ORDERED_RE.test(t);
  const plan = hasAny(t, PLAN_WORDS) || hasAny(t, USUAL_WORDS);
  const mealFrame = hasMealFrame(t); // false when NEGATION_RE matches
  const food = looksLikeFood(t);
  const spend = SPEND_RE.test(t) || extractAmount(t) != null;

  // (0) shopping-list / negated / intent frame ("need to buy eggs", "out of milk",
  //     "skipped lunch", "thinking about pizza") is NOT a completed event.
  if (NEGATION_RE.test(t) && !ate) return "none";

  // (1) PLAN — a plan/usual/target cue with no actual past/now eating verb.
  if (plan && !ate) return "plan";

  // (2) an explicit eat verb beats everything ("bought a sandwich and ate it").
  if (ate) return "ate";

  // (3) a hard purchase word (groceries/stock/bought/picked up/…) -> bought.
  if (hardBuy) return "bought";

  // (4) a bare "ordered/order": a delivery with a MEAL frame ("ordered lunch from
  //     swiggy") is eating; "ordered a cake for the party" is a purchase.
  if (ordered) return mealFrame ? "ate" : "bought";

  // (5) a meal frame with no buy/plan cue is consumption ("for lunch").
  if (mealFrame) return "ate";

  // (6) paid-for food with no grocery cue = a meal eaten out
  //     ("spent 120 for mushroom sandwich and rose milk").
  if (spend && food) return "ate";

  // (7) a food word with no eat/buy/plan/meal/spend cue is genuinely ambiguous.
  if (food) return "none";

  // (8) non-food text.
  return "none";
}

// ---- domain routing ----

// Return the de-duped, stable-ordered subset of ['money','diet','gym','wellness']
// a capture touches. Critically, food that was BOUGHT/PLANNED is NOT 'diet' — only
// food that was actually eaten routes to the diet tracker.
export function classifyDomains(text = "") {
  const t = lc(text);
  const out = [];
  const consumption = classifyConsumption(t);

  // money: an extractable amount, or any buy/grocery cue.
  if (extractAmount(t) != null || hasAny(t, BUY_WORDS) || hasAny(t, GROCERY_WORDS)) {
    out.push("money");
  }
  // diet: only an actually-eaten food.
  if (looksLikeFood(t) && consumption === "ate") out.push("diet");
  // gym: any workout free-text.
  if (looksLikeGym(t)) out.push("gym");
  // wellness: sleep / mood / stress / water / steps / weight / meditate cues.
  if (hasAny(t, WELLNESS_WORDS)) out.push("wellness");

  const order = ["money", "diet", "gym", "wellness"];
  return order.filter((d) => out.includes(d));
}

// ---- gym detection ----

// True when the text describes a workout — a gym/exercise keyword, a cardio word,
// a parseable exercise, or a bare set×rep pattern. Walk/steps alone still count
// (the caller decides workout_log vs body_metric).
// Some cardio words collide with non-exercise idioms ("grocery run", "milk run",
// "run an errand"). Strip those before the cardio check so a shopping trip isn't
// read as a workout.
const CARDIO_FALSE_FRIENDS = /\b(?:grocery|milk|beer|coffee|supply|errand)\s+run\b|\brun\s+(?:an?\s+)?errands?\b/;

export function looksLikeGym(text = "") {
  let t = lc(text);
  if (!t.trim()) return false;
  if (hasAny(t, GYM_WORDS)) return true;
  const tCardio = t.replace(CARDIO_FALSE_FRIENDS, " ");
  if (hasAny(tCardio, CARDIO_WORDS)) return true;
  if (SET_REP_RE.test(t)) return true;
  if (parseExercises(t).length > 0) return true;
  return false;
}

// ---- exercise parsing ----

// Split a workout description into clauses on commas / "then" / "and" / newlines.
function splitClauses(text) {
  return String(text || "")
    .split(/\n|,|;|\bthen\b|\band\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Strip a leading logging verb ("did", "i did", "i", "just") so the exercise name
// is clean.
function stripLeadVerb(name) {
  return name
    .replace(/^(?:i\s+)?(?:just\s+)?(?:did|do|done|hit|then)\s+/i, "")
    .replace(/^(?:i|just)\s+/i, "")
    .trim();
}

// Normalize an exercise label: lowercased, single-spaced, trailing junk stripped.
function normName(name) {
  const n = stripLeadVerb(String(name || ""))
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n;
}

// Best-effort structured parse. Returns [{exercise, sets, reps, weight_kg}] for
// every clause that carries a set×rep and/or weight pattern; never invents
// reps/sets, returns [] when no quantitative pattern is present.
export function parseExercises(text = "") {
  const out = [];
  for (const clause of splitClauses(text)) {
    const setRep = clause.match(SET_REP_RE);
    const weight = clause.match(WEIGHT_RE);

    // Single-set "name 60kg x12" (weight then a bare "xR").
    const singleSet = clause.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|lbs)\b[^0-9]*[x×]\s*(\d+)/i);

    let sets = null, reps = null, weight_kg = null, cut = -1;

    if (setRep) {
      sets = Number(setRep[1]);
      reps = Number(setRep[2]);
      cut = clause.indexOf(setRep[0]);
      if (weight) weight_kg = Number(weight[1]);
    } else if (singleSet) {
      sets = 1;
      weight_kg = Number(singleSet[1]);
      reps = Number(singleSet[2]);
      cut = clause.search(/\d/);
    } else {
      continue; // no quantitative pattern -> not a structured exercise
    }

    // The exercise name is whatever text precedes the first numeric token.
    const firstNum = clause.search(/\d/);
    const namePart = clause.slice(0, firstNum >= 0 ? firstNum : clause.length);
    const exercise = normName(namePart);
    if (!exercise) continue;

    out.push({ exercise, sets, reps, weight_kg });
  }
  return out;
}
