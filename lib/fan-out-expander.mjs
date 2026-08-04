// Deterministic fan-out + SALVAGE: guarantees a single real event lands in every
// tracker it belongs to, even when the model under-emits OR bails to review on a
// capture that is obviously a food/spend. Three jobs:
//   1. fan-out   - an expense at a food merchant also yields a food_log.
//   2. salvage   - if the model only asked for review (or missed half the capture)
//                  but the text clearly contains a spend amount and/or food, we
//                  synthesize the expense/food candidates ourselves so trivial
//                  captures auto-apply instead of landing in "needs a look".
//   3. backdate  - salvaged candidates honour "yesterday", "last night", "on 25
//                  June" etc. so a remembered event lands on the right day.
// Pure (no DOM/Supabase) so it's tested; the edge function keeps an inline mirror.

import { looksLikeGym } from "./capture-intent.mjs";
import { isChangeRequest, carriesLoggedEvent } from "./request-router.mjs";
import { isEventDenied, declaresNoWorkout, splitNegationClauses, clauseDeniesEvent, isAlreadyRecorded, alreadyRecordedSpans } from "./negation.mjs";
import { FOOD_TABLE } from "./food-nutrition.mjs";

const FOOD_MERCHANTS = [
  "zomato", "swiggy", "blinkit", "zepto", "instamart", "dominos", "domino", "mcdonald", "kfc",
  "starbucks", "subway", "pizza", "burger", "cafe", "coffee", "restaurant", "dhaba", "bakery",
  "biryani", "faasos", "eatfit", "box8", "behrouz", "wow momo", "chaayos", "haldiram", "barbeque",
  "burger king", "pizza hut", "dunkin", "baskin", "chai point", "theobroma", "la pino", "eatsure",
  "freshmenu", "ovenstory", "taco bell", "third wave", "blue tokai", "keventers", "bikanervala",
  "nandos", "sweet truth",
];
// Cues the nutrition table does NOT carry: meal slots, consumption verbs, and
// dishes we can name but not yet price. Everything the table DOES know is folded
// in below rather than restated here - see FOOD_WORDS.
//
// Keeping a second hand-written food list was the bug: 119 of the 254 foods
// food-nutrition.mjs could already price were invisible to salvage (coke, cola,
// chips, biscuit, bread, cheese, whey…), so a capture naming only those got no
// food row at all while the very next module stood ready to price it.
const EXTRA_FOOD_WORDS = [
  "lunch", "dinner", "breakfast", "snack", "meal", "thali", "biryani", "roti", "rotis", "dal", "sabzi",
  "rice", "paneer", "egg", "eggs", "chicken", "mutton", "dosa", "idli", "poha", "sandwich", "salad",
  "shake", "smoothie", "fruit", "curd", "yogurt", "momo", "noodles", "pasta", "ate", "eaten", "food",
  "maggi", "cake", "milk", "cookies", "chai", "tea", "juice", "soup", "oats", "banana", "apple",
  "omelette", "omelet", "upma", "paratha", "khichdi", "sambar", "vada", "uttapam", "pulao", "lassi",
  "buttermilk", "samosa", "pakora", "halwa", "kheer", "jalebi", "sprouts", "tofu", "soya", "soybean",
  "soybeans", "fish", "prawns", "kebab", "tikka", "naan", "kulcha", "aloo", "palak", "rajma", "chole",
  "chana", "dahi", "muesli", "granola", "almonds", "peanuts", "shawarma", "poori", "puri", "chaat",
  "curry", "coffee",
];

// The salvage vocabulary IS the nutrition table's vocabulary, plus the extras
// above. Derived, never hand-maintained: adding a food to food-nutrition.mjs now
// teaches salvage about it in the same edit, so the two can no longer drift.
// Aliases under 3 chars are dropped ("pb") - too short to match safely on \b.
export const FOOD_WORDS = (() => {
  const words = new Set(EXTRA_FOOD_WORDS);
  for (const entry of FOOD_TABLE) {
    for (const alias of entry.aliases) {
      const a = String(alias).trim().toLowerCase();
      if (a.length >= 3) words.add(a);
    }
  }
  return [...words];
})();

// Words that name WHEN you ate, not WHAT - matching only these means no dish was
// named, so no macros can ever be derived.
const MEAL_SLOT_WORDS = new Set(["lunch", "dinner", "breakfast", "snack", "meal", "food", "ate", "eaten"]);

// Every food cue present in the text (merchants + food words).
export function foodCuesIn(text = "") {
  const t = String(text).toLowerCase();
  const hits = [];
  for (const m of FOOD_MERCHANTS) if (t.includes(m)) hits.push(m);
  for (const w of FOOD_WORDS) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) hits.push(w);
  return hits;
}

export function looksLikeFood(text = "") {
  return foodCuesIn(text).length > 0;
}

// True when the text names an actual dish/merchant, not just a meal slot.
// "Also yesterday lunch paid 110" names no dish - synthesizing a food row from it
// produced a NULL-macro meal that skewed the day's calories and meal count.
export function namesDish(text = "") {
  return foodCuesIn(text).some((cue) => !MEAL_SLOT_WORDS.has(cue));
}

// Buying provisions ("bought paneer and curd", "groceries for the week") is an
// EXPENSE, not a meal - you haven't eaten it yet. Detect that so we never log a
// grocery run as food. A clear consumption cue overrides it (you can buy a
// sandwich and eat it), so "bought lunch and ate it" still counts as a meal.
const PURCHASE_CUE = /\b(bought|buy|buying|purchas\w+|grocer\w+|stock(?:ed|ing)?\s*up)\b/i;
const FOR_LATER_CUE = /\bfor the (?:week|month|fridge|freezer|house|home|pantry)\b/i;
const CONSUMPTION_CUE = /\b(ate|eat|eaten|eating|had|having|drank|drink|drinking|consumed|breakfast|lunch|dinner|snack|brunch|supper|meal)\b/i;

// "lunch", "dinner - 110", "meal" - a slot name with no dish in it. Such a label
// can never be turned into macros, so it must not become a food row.
const BARE_MEAL_LABEL = /^(?:the\s+)?(?:breakfast|lunch|dinner|brunch|supper|snack|meal|food)s?$/i;

export function isBareMealLabel(label = "") {
  const cleaned = String(label)
    .toLowerCase()
    .replace(/\(auto from spend\)/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return BARE_MEAL_LABEL.test(cleaned);
}

export function looksLikePurchase(text = "") {
  const t = String(text).toLowerCase();
  if (CONSUMPTION_CUE.test(t)) return false;
  return PURCHASE_CUE.test(t) || FOR_LATER_CUE.test(t);
}

// Does this clause talk about money at all? Used to scope the already-recorded
// guard: "the ticket was around 484, logged that so I don't want to log it
// again" must suppress the expense without touching the food in the next clause.
export function mentionsMoney(text = "") {
  return /(?:spent|spend|paid|pay|paying|bought|buy|cost|costs|price|rs\.?|inr|rupees?|₹|ticket|bill|share|refund|reimburs\w*)/i
    .test(String(text));
}

// The IST hour of an instant. Reading the hour TEXTUALLY out of the ISO string is
// what this used to do, and it is right only when the string already carries
// +05:30. The model routinely emits Z, so "2026-07-28T09:15:07Z" was bucketed as
// hour 9 (breakfast) when it is really 14:45 IST (lunch). Parse the instant.
export function istHourOf(iso) {
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) {
    const m = String(iso).match(/T(\d{2}):/); // unparseable: fall back to the text
    return m ? Number(m[1]) : 12;
  }
  return new Date(t + 5.5 * 3_600_000).getUTCHours();
}

// Bands widened from the original 15:00 lunch cut-off to 16:00, and snack narrowed
// to 16-18, because the old boundaries called a 15:30 IST lunch a snack.
export function mealSlotFromTime(iso) {
  const h = istHourOf(iso);
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 16) return "lunch";
  if (h >= 16 && h < 18) return "snack";
  if (h >= 18 && h < 23) return "dinner";
  return "other";
}

// Which slot a capture NAMES, if any. "had idli for dinner" is a statement about
// the meal, and it outranks the clock - people eat a late dinner at 01:00.
const SLOT_WORDS = [
  ["breakfast", /\b(breakfast|nashta)\b/i],
  ["lunch", /\blunch\b/i],
  ["dinner", /\b(dinner|supper)\b/i],
  ["snack", /\b(snack|snacked)\b/i],
];

export function slotNamedIn(text = "") {
  for (const [slot, rx] of SLOT_WORDS) if (rx.test(String(text))) return slot;
  return null;
}

// Hours at which a given slot label is IMPOSSIBLE, in IST. Deliberately narrow:
// a late dinner at 01:00 and a snack at any hour are both perfectly normal, so
// neither is listed. Only labels that cannot describe the hour are.
const IMPOSSIBLE_AT = {
  breakfast: (h) => h >= 12,             // breakfast in the afternoon or evening
  lunch: (h) => h >= 18 || (h >= 4 && h < 9), // lunch at dinner time or at dawn
  dinner: (h) => h >= 5 && h < 15,       // dinner in the morning or at midday
  snack: () => false,                    // a snack is a size, not an hour
};

// The slot a food row should carry. Authority order, highest first:
//   1. a slot the CAPTURE named - "had idli for dinner" says what meal it was.
//   2. the model's own label, KEPT unless it is impossible for the IST hour.
//   3. the IST clock - used to fill a blank/"other", or to replace an impossible
//      label.
//
// Measured over all 103 real captures: 31 of 62 stored food rows disagreed with
// their own IST hour, because the prompt never told the model to derive the slot
// from the clock and mealSlotFromTime bucketed a Z timestamp off the UTC hour
// ("2026-07-28T09:15:07Z" -> breakfast, when it is 14:45 IST).
//
// But replacing the label with the clock outright is worse, not better: it turned
// 2,475 kcal of pizza at 17:50 into a "snack" and movie popcorn at 11:51 into
// "lunch". The model's semantic read is usually right and the clock is only a
// reliable veto, so this corrects "breakfast at 14:45" and leaves "snack at
// 17:00" alone.
export function resolveMealSlot(modelSlot, occurredAtIso, evidence = "") {
  const named = slotNamedIn(evidence);
  if (named) return named;
  const usable = occurredAtIso && !Number.isNaN(Date.parse(String(occurredAtIso)));
  if (!usable) return modelSlot || "other";
  const clock = mealSlotFromTime(occurredAtIso);
  if (!modelSlot || modelSlot === "other") return clock;      // fill a non-answer
  const impossible = IMPOSSIBLE_AT[modelSlot];
  if (impossible && impossible(istHourOf(occurredAtIso))) return clock;
  return modelSlot;                                            // the model's read stands
}

function minutesApart(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

// ---- amount extraction (only when a real money cue is present) ----
// We deliberately do NOT treat a bare trailing number as money (it could be a
// weight, ml, steps…). A salvaged expense needs an explicit cue: "spent/paid/Rs",
// a currency suffix, or a "… - 120" / "… : 120" price tail.
const MONEY_CUE = /(?:spent|spend|paid|pay|bought|buy|cost|costs|rs\.?|inr|rupees?|₹)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i;
const MONEY_SUFFIX = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:rs\.?|inr|rupees?|₹|bucks)\b/i;
const MONEY_TRAIL = /[---:]\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\/?-?\s*$/;

// MONEY_TRAIL is the weakest cue by far: it reads ANY trailing "- 120" / ": 60" as
// a price, with no currency word anywhere. That is fine for the short price note it
// was written for ("2 paneer rolls - 350") and actively wrong for a pasted
// instrument readout, where the last line is a labelled metric. A gym screenshot
// ending "METs: 5.5" became a Rs 5.50 expense on 2026-08-03, with the whole cardio
// display as its description. Two guards, both cheap:
//   - a multi-line block is a document, not a price note; the trail cue is off.
//   - a label that names a UNIT of something is never a price, even on one line.
const METRIC_LABEL = /\b(mets?|bmi|kg|kgs|lbs|km|kms|cal|cals|kcal|calories|reps?|sets?|rpm|bpm|watts?|w|level|incline|resistance|speed|pace|distance|duration|time|steps?|floors?|spo2|hba1c|sugar|temp|weight|height|hr|heart\s*rate|protein|carbs?|fat|fibre|fiber|sodium)\s*[---:]\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*\/?-?\s*$/i;

function moneyTrailAmount(text = "") {
  const t = String(text);
  if (/[\n\r]/.test(t)) return null;      // a document, not a price note
  if (METRIC_LABEL.test(t)) return null;  // "resistance: 17" is not seventeen rupees
  const m = t.match(MONEY_TRAIL);
  return m ? m[1] : null;
}

export function extractAmount(text = "") {
  for (const rx of [MONEY_CUE, MONEY_SUFFIX]) {
    const m = String(text).match(rx);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const trail = moneyTrailAmount(text);
  if (trail != null) {
    const n = Number(trail.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// What was the spend ON - the "on/for X" tail makes a tidy merchant label.
function spendTargetFrom(text = "") {
  const m = String(text).match(/\b(?:on|for|at)\s+(.+)$/i);
  if (!m) return null;
  return m[1].replace(MONEY_TRAIL, "").replace(/[.,!]+$/, "").trim().slice(0, 60) || null;
}

// ---- relative / explicit date resolution for salvaged candidates ----
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Abbreviation or full name, and it must END on a word boundary - see the note at
// the explicit-date branch in resolveOccurredAt for why the missing \b was a bug.
const MONTH_RX = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b`;

function istParts(date) {
  const ist = new Date(date.getTime() + 5.5 * 3_600_000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth(), d: ist.getUTCDate() };
}

// Pick an hour-of-day from time-of-day words (returns null when none present).
function hourFromWords(t) {
  if (/\b(night|tonight|dinner|midnight)\b/.test(t)) return 21;
  if (/\b(evening|snack)\b/.test(t)) return 17;
  if (/\b(afternoon|lunch|noon)\b/.test(t)) return 13;
  if (/\b(morning|breakfast|dawn)\b/.test(t)) return 8;
  return null;
}

// Resolve an ISO timestamp (IST, +05:30) for a salvaged candidate from free text,
// relative to `now`. Honours yesterday / day-before / last night / "on 25 Jun" /
// "25/06". Falls back to `now` when the text carries no date hint.
export function resolveOccurredAt(text = "", now = "") {
  const base = now ? new Date(now) : new Date();
  if (Number.isNaN(base.getTime())) return new Date().toISOString();
  const t = String(text).toLowerCase();
  const { y, m, d } = istParts(base);
  let year = y, month = m, day = d, offset = 0, dated = false;

  // Explicit "25/06[/2026]".
  let mm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (mm) {
    day = Number(mm[1]); month = Number(mm[2]) - 1;
    if (mm[3]) year = Number(mm[3].length === 2 ? `20${mm[3]}` : mm[3]);
    dated = true;
  }
  // Explicit "25 June" / "June 25" / "25th jun".
  //
  // The month name MUST end on a word boundary. Without that, the 3-letter
  // abbreviation matches the PREFIX of any word that happens to start with it,
  // and a number sits in front of nearly every food: "2 Margherita pizzas" was
  // read as 2 March and silently filed a 2026-08-02 meal under 2026-03-02, five
  // months back, where nothing would ever show it. Same trap for "2 marinated",
  // "2 mayonnaise", "1 decaf", "2 junk food", "1 julienne", "2 octopus",
  // "4 novelty", "1 apricot". Full names still match ("25 September").
  if (!dated) {
    mm = t.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH_RX}`, "i"))
      || (() => { const r = t.match(new RegExp(String.raw`\b${MONTH_RX}\s+(\d{1,2})\b`, "i")); return r ? [r[0], r[2], r[1]] : null; })();
    if (mm) { day = Number(mm[1]); month = MONTHS.indexOf(String(mm[2]).slice(0, 3).toLowerCase()); dated = true; }
  }
  // Relative words (only if no explicit date won).
  if (!dated) {
    if (/\b(day before yesterday|two days ago)\b/.test(t)) offset = -2;
    else if (/\b(yesterday|last night|last evening)\b/.test(t)) offset = -1;
    else if (/\b(today|tonight|just now|now)\b/.test(t)) offset = 0;
  }

  // Hour: an explicit time word wins; otherwise a same-day capture keeps the real
  // current hour, while a different day with no time hint defaults to noon.
  const sameDay = !dated && offset === 0;
  const istHour = new Date(base.getTime() + 5.5 * 3_600_000).getUTCHours();
  const hour = hourFromWords(t) ?? (sameDay ? istHour : 12);
  const at = new Date(Date.UTC(year, month, day + offset, hour, 0, 0));
  const Y = at.getUTCFullYear();
  const Mo = String(at.getUTCMonth() + 1).padStart(2, "0");
  const Da = String(at.getUTCDate()).padStart(2, "0");
  const H = String(at.getUTCHours()).padStart(2, "0");
  return `${Y}-${Mo}-${Da}T${H}:00:00+05:30`;
}

// Keep the review request only when nothing was salvaged, or when it flags a real
// safety concern (prompt injection) that must reach a human regardless.
function isSafetyReview(tc) {
  const reason = String(tc?.arguments?.reason || "").toLowerCase();
  return reason.includes("injection") || reason.includes("malicious");
}

// Given the model's validated tool calls, return them PLUS any synthesized fan-out
// / salvage calls, with stale review requests dropped once the capture is resolved.
export function expandToolCalls(toolCalls = [], { evidence = "", now = "" } = {}) {
  let out = [...toolCalls];
  // A grocery run is an expense, not a meal - suppress all food synthesis below.
  const purchase = looksLikePurchase(evidence);
  // A CHANGE REQUEST / QUERY ("change my plan", "raise my budget", "how much…") is
  // NOT a loggable event - suppress ALL deterministic log-salvage so we never write
  // a ledger/food/workout row or tick a checklist for a command. The brain still
  // routes it to update_plan_candidate / set_target_candidate. A mixed message that
  // also logs something ("…also I ate dal") keeps salvage on.
  const command = isChangeRequest(evidence) && !carriesLoggedEvent(evidence);
  // DENIAL: the capture names a domain only to say it did NOT happen ("no gym
  // today", "skipped lunch"). Salvage must stay off, and any positive row the
  // model emitted for that domain is dropped - a denial is evidence AGAINST the
  // event, so it outranks a low-confidence guess.
  const gymDenied = declaresNoWorkout(evidence, looksLikeGym);
  const foodDenied = isEventDenied(evidence, looksLikeFood);
  // ALREADY RECORDED: the event happened and the user is telling us it is
  // already in the app. A day journal is full of these - "had popcorn today,
  // paid my share, already logged" - and re-logging them is what took
  // 2026-08-01 from ~1,850 kcal to 3,315. Suppress the write, and remember what
  // was suppressed so the caller can SAY so rather than drop it silently.
  const foodAlready = isAlreadyRecorded(evidence, looksLikeFood);
  const moneyAlready = isAlreadyRecorded(evidence, mentionsMoney);
  const hasExpense = () => out.some((tc) => tc?.name === "create_expense_candidate");
  const hasFood = () => out.some((tc) => tc?.name === "create_food_log_candidate");

  // 1. Fan-out: model-emitted food-merchant expense -> matching food_log.
  //    Skipped for a grocery purchase (buying food ≠ eating it) or a command.
  if (!purchase && !command && !foodDenied) for (const tc of toolCalls) {
    if (tc.name !== "create_expense_candidate") continue;
    const a = tc.arguments || {};
    const label = `${a.merchant || ""} ${a.description || ""}`;
    if (!looksLikeFood(label)) continue;
    // A bare meal-slot label ("lunch", "dinner") names no actual food, so the
    // synthesized row can never carry macros - it lands as a 0-calorie meal that
    // drags the day's totals and meal count off. Only fan out when a real item
    // is named. ("Also yesterday lunch paid 110" is a spend, not a meal record.)
    if (isBareMealLabel(label)) continue;
    const occurredAt = a.occurred_at;
    const dup = out.some((f) => f.name === "create_food_log_candidate" && minutesApart(f.arguments?.occurred_at, occurredAt) <= 2);
    if (dup) continue;
    out.push({
      name: "create_food_log_candidate",
      arguments: {
        meal_slot: mealSlotFromTime(occurredAt),
        description: `${a.merchant || a.description || "meal"} (auto from spend)`,
        occurred_at: occurredAt,
        _auto_expanded: true,
      },
      confidence: Math.round(Number(tc.confidence || 0.7) * 0.6 * 100) / 100,
    });
  }

  const ev = String(evidence || "").trim();
  const occurredAt = resolveOccurredAt(ev, now);

  // 2. Salvage an EXPENSE the model missed (only with an explicit money cue).
  const amount = extractAmount(ev);
  if (amount != null && !hasExpense() && !command && !moneyAlready) {
    const merchant = spendTargetFrom(ev);
    out.push({
      name: "create_expense_candidate",
      arguments: {
        amount,
        currency: "INR",
        merchant: merchant || null,
        description: ev.replace(MONEY_TRAIL, "").trim().slice(0, 120),
        occurred_at: occurredAt,
        is_discretionary: true,
        _auto_expanded: true,
      },
      confidence: 0.6,
    });
  }

  // 3. Salvage FOOD the model missed (even alongside an expense), so a food+spend
  //    capture lands in BOTH trackers and never sits in review. Not for a grocery
  //    purchase - that's an expense, not something eaten.
  if (!purchase && !command && !foodDenied && !foodAlready && namesDish(ev) && !hasFood()) {
    out.push({
      name: "create_food_log_candidate",
      arguments: {
        meal_slot: mealSlotFromTime(occurredAt),
        description: ev.replace(MONEY_TRAIL, "").trim().slice(0, 120),
        occurred_at: occurredAt,
        _auto_expanded: true,
      },
      confidence: 0.6,
    });
  }

  // 3b. A clear grocery purchase: drop any food_log (even one the model emitted) -
  //     the user bought provisions, they did not eat them. Keeps the expense.
  if (purchase) out = out.filter((tc) => tc?.name !== "create_food_log_candidate");

  // 3b-ii. The user said they did NOT eat: drop every food row, model's included.
  if (foodDenied) out = out.filter((tc) => tc?.name !== "create_food_log_candidate");

  // 3b-iii. Drop the rows the capture itself says are ALREADY logged.
  //     Per ROW, not per capture: a day journal mixes both in one breath, and
  //     suppressing the whole domain would lose the burrito to save the popcorn.
  out = dropAlreadyRecordedRows(out, ev);

  // 3c. WORKOUT. A denial ("no gym today") is recorded as an explicit `skipped`
  //     row rather than dropped: that keeps it out of the streak and the "you
  //     trained yesterday" brief, while still telling the evening nudge the day
  //     was answered. Only an affirmative capture salvages a real workout.
  if (!command && gymDenied) {
    out = out.filter((tc) => tc?.name !== "create_workout_log_candidate");
    out.push({
      name: "create_workout_log_candidate",
      arguments: {
        // Just the clause that denies the workout, not the whole capture.
        // "drakn 500 g curd, with 2 scoops of protien powder. and no gym today"
        // was landing verbatim as the workout description, so the Gym log read
        // like a meal.
        description: denialClause(ev, looksLikeGym) || ev.replace(MONEY_TRAIL, "").trim().slice(0, 120),
        occurred_at: occurredAt,
        status: "skipped",
        _auto_expanded: true,
      },
      confidence: 0.9,
    });
    // ...and reporting a miss must NOT rewrite the plan you missed.
    //
    // On 2026-07-31 "no gym today" produced BOTH the skipped row above and an
    // update_plan_candidate replacing the day's Workout B with Rest - applied at
    // confidence 0.55, because there is no review gate. The two then disagree:
    // workout_logs says you skipped a session, user_plans says today was always
    // a rest day. The plan is what jbPlannedWorkout reads, so the miss becomes
    // `workout_forgiven`, the evening nudge goes quiet, and tomorrow's brief
    // calls it a rest day. Every miss you honestly report would launder itself
    // into a planned rest, and the consistency numbers would stop meaning
    // anything.
    //
    // A same-day denial is a LOG of what happened. Only an actual instruction
    // ("change my gym today to rest") is a plan change, and the router already
    // separates those - `command` is false here precisely because this is a log.
    // Multi-day scopes survive: "going to Nagpur tomorrow and the day after, no
    // gym today" really is telling us about days that have not happened yet.
    out = out.filter((tc) => !isSameDayGymPlanChange(tc, occurredAt));
  } else if (!command && looksLikeGym(ev) && !out.some((tc) => tc?.name === "create_workout_log_candidate")) {
    // Gym free-text is a workout even without the word "gym" ("did Workout A",
    // "bench 3x10 60kg", "ran 5k", "walked 35 min").
    out.push({
      name: "create_workout_log_candidate",
      arguments: { description: ev.replace(MONEY_TRAIL, "").trim().slice(0, 120), occurred_at: occurredAt, status: "done", _auto_expanded: true },
      confidence: 0.6,
    });
  }

  // 3d. A note must never restate a row we just wrote.
  //
  //     `create_note_candidate` is the model's fallback for "this is prose, not
  //     an event". When salvage turns the SAME sentence into a real domain row,
  //     keeping the note files one event in two places. Every note in the live
  //     database was this: "In gym, doing back" became both a note and a
  //     workout_log one second apart; "No gym today" became both a note and a
  //     skipped workout; the Coca-Cola order manifest became both a note and a
  //     food_log. Not one of them carried information the domain row lacked.
  //
  //     Only a note that says something BEYOND the row is kept, so a genuine
  //     mixed capture ("ate 6 eggs, also cancel the trainer on Friday") still
  //     records its remainder.
  out = dropRestatingNotes(out, ev);

  // 4. Once anything real was captured, drop the now-stale review request (unless
  //    it's a genuine safety flag). This is what clears "needs a look".
  const hasWrite = out.some((tc) => typeof tc?.name === "string" && tc.name.startsWith("create_"));
  if (hasWrite) out = out.filter((tc) => tc?.name !== "request_user_review" || isSafetyReview(tc));

  return out;
}

// The clause that actually carries the denial, for use as the row's description.
// Falls back to null so the caller keeps its existing behaviour.
function denialClause(text, mentions) {
  for (const clause of splitNegationClauses(text)) {
    if (clauseDeniesEvent(clause) && mentions(clause)) return clause.trim().slice(0, 120);
  }
  return null;
}

/**
 * Is this an `update_plan_candidate` that only rewrites the gym plan for the one
 * day the capture is about?
 *
 * Those are the ones a bare denial must not produce. A scope naming several days
 * (or days other than this one) is a real forward-looking change and survives -
 * the difference between "no gym today" and "I'm travelling Sunday to Tuesday".
 */
export function isSameDayGymPlanChange(tc, occurredAt) {
  if (tc?.name !== "update_plan_candidate") return false;
  const a = tc.arguments || {};
  if (a.kind !== "gym") return false;
  const scope = String(a.scope || "").trim();
  if (!scope) return true;                    // permanent - even worse for a denial
  const days = scope.split(/[,\s]+/).filter(Boolean);
  if (days.length !== 1) return false;        // multi-day = a real plan change
  const day = String(occurredAt || "").slice(0, 10);
  return !day || days[0] === day;
}

// Rows the "already logged" guard applies to. A workout is excluded on purpose:
// a denied or duplicated workout has its own, better-tested path.
const ALREADY_GUARDED = new Set(["create_food_log_candidate", "create_expense_candidate"]);

function rowTokens(tc) {
  const a = tc?.arguments || {};
  const text = [a.description, a.merchant, a.meal_name, a.note].filter(Boolean).join(" ");
  const words = String(text).toLowerCase().match(/[a-z]{3,}/g) || [];
  const amount = Number(a.amount);
  return { words: new Set(words), amount: Number.isFinite(amount) && amount > 0 ? amount : null };
}

// How well does this row correspond to this clause? Word overlap, plus a strong
// signal when the clause literally contains the row's amount ("around 484").
function rowClauseScore(row, clause) {
  const c = String(clause).toLowerCase();
  let score = 0;
  for (const w of row.words) if (c.includes(w)) score += 1;
  if (row.amount != null) {
    const nums = (c.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/,/g, "")));
    if (nums.some((n) => Math.abs(n - row.amount) < 0.5)) score += 3;
  }
  return score;
}

/**
 * Drop every candidate row whose own clause says it is already logged.
 *
 * Each row is attributed to the clause it best matches, then dropped if that
 * clause falls inside an "already logged" span. Rows that match nothing are
 * kept - never drop on a guess.
 */
export function dropAlreadyRecordedRows(toolCalls = [], evidence = "") {
  const { clauses, covered } = alreadyRecordedSpans(evidence);
  if (!covered.size || !clauses.length) return [...toolCalls];

  return toolCalls.filter((tc) => {
    if (!ALREADY_GUARDED.has(tc?.name)) return true;
    const row = rowTokens(tc);
    if (!row.words.size && row.amount == null) return true;
    let bestIdx = -1;
    let bestScore = 0;
    clauses.forEach((clause, i) => {
      const sc = rowClauseScore(row, clause);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    });
    if (bestIdx < 0) return true;             // matched nothing - keep it
    return !covered.has(bestIdx);
  });
}

// Domain writes - a note alongside one of these is a candidate restatement.
const DOMAIN_WRITES = new Set([
  "create_food_log_candidate", "create_expense_candidate", "create_workout_log_candidate",
  "create_sleep_candidate", "create_hydration_candidate", "create_body_metric_candidate",
  "create_wellness_note_candidate",
]);

// Word bag, minus filler that carries no meaning on its own. Comparing bags
// rather than strings keeps this robust to the model lightly rewording the
// capture ("No gym today," -> "No gym today").
const NOTE_FILLER = new Set([
  "a", "an", "and", "the", "to", "too", "of", "for", "in", "on", "at", "is", "was", "am", "i",
  "my", "me", "it", "so", "will", "did", "do", "today", "also", "just", "some", "bro", "yeah",
]);
function noteWordBag(s) {
  return new Set(
    String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w && !NOTE_FILLER.has(w)),
  );
}

// A note that repeats ~all of the capture is the capture, restated.
const RESTATES_CAPTURE = 0.8;
// ...unless it also brings this much of its own, in which case it is a note
// that happens to quote the capture ("went to gym, felt strong").
const CARRIES_OWN_CONTENT = 0.3;

/**
 * Drop every `create_note_candidate` whose body is a restatement of the capture
 * that already produced a domain row.
 *
 * The test is COVERAGE of the evidence, not novelty in the note. A note that
 * repeats the whole sentence is redundant with the rows built from that same
 * sentence. A note covering only part of it is the remainder of a mixed capture
 * ("ate 6 eggs, also cancel the trainer") and has to survive - that leftover is
 * the only place the non-loggable half is recorded.
 */
export function dropRestatingNotes(toolCalls = [], evidence = "") {
  const calls = [...toolCalls];
  if (!calls.some((tc) => DOMAIN_WRITES.has(tc?.name))) return calls;
  const evBag = noteWordBag(evidence);
  if (!evBag.size) return calls;

  return calls.filter((tc) => {
    if (tc?.name !== "create_note_candidate") return true;
    const noteBag = noteWordBag(tc.arguments?.body);
    if (!noteBag.size) return false; // an empty note is never worth a row

    let shared = 0;
    for (const w of evBag) if (noteBag.has(w)) shared += 1;
    const coverage = shared / evBag.size;

    let novel = 0;
    for (const w of noteBag) if (!evBag.has(w)) novel += 1;
    const ownContent = novel / noteBag.size;

    return !(coverage >= RESTATES_CAPTURE && ownContent <= CARRIES_OWN_CONTENT);
  });
}
