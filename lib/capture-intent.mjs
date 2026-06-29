// GYM DETECTION — is a capture a workout, and what exercises does it name?
// Pure (no DOM/Supabase) so it's tested directly; the edge function keeps an
// inline mirror (GYM_CUE/CARDIO_CUE regexes), guarded by tests/mirror-parity.
//
// NOTE: eat-vs-buy intent lives solely in lib/fan-out-expander.mjs (looksLikePurchase)
// and command/plan intent in lib/request-router.mjs — this module is gym-only, so
// there is ONE source of truth per concern (no overlaps). It deliberately does not
// re-implement consumption classification.

// ---- lexicons (exported so the index.ts mirror + tests share one source) ----

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

// set×rep ("3x10", "3 × 10") and weight ("60kg", "60 kg", "@60kg") cues.
export const SET_REP_RE = /(\d+)\s*[x×]\s*(\d+)/i;
export const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(?:kg|kgs|lbs)\b/i;

// ---- helpers ----

function lc(text) {
  return String(text || "").toLowerCase();
}

// Multiword phrases are matched with includes (so "leg press" works); single
// tokens use a word boundary so "ran" never matches inside "errand".
function hasAny(t, words) {
  return words.some((w) => {
    if (/[^a-z0-9]/.test(w)) return t.includes(w);
    return new RegExp(`\\b${w}\\b`).test(t);
  });
}

// ---- gym detection ----

// Some cardio words collide with non-exercise idioms ("grocery run", "milk run",
// "run an errand"). Strip those before the cardio check so a shopping trip isn't
// read as a workout.
const CARDIO_FALSE_FRIENDS = /\b(?:grocery|milk|beer|coffee|supply|errand)\s+run\b|\brun\s+(?:an?\s+)?errands?\b/;

// True when the text describes a workout — a gym/exercise keyword, a cardio word,
// a parseable exercise, or a bare set×rep pattern. Walk/steps alone still count
// (the caller decides workout_log vs body_metric).
export function looksLikeGym(text = "") {
  const t = lc(text);
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
  return stripLeadVerb(String(name || ""))
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

    let sets = null, reps = null, weight_kg = null;

    if (setRep) {
      sets = Number(setRep[1]);
      reps = Number(setRep[2]);
      if (weight) weight_kg = Number(weight[1]);
    } else if (singleSet) {
      sets = 1;
      weight_kg = Number(singleSet[1]);
      reps = Number(singleSet[2]);
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
