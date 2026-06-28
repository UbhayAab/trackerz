// Deterministic fan-out + SALVAGE: guarantees a single real event lands in every
// tracker it belongs to, even when the model under-emits OR bails to review on a
// capture that is obviously a food/spend. Three jobs:
//   1. fan-out   — an expense at a food merchant also yields a food_log.
//   2. salvage   — if the model only asked for review (or missed half the capture)
//                  but the text clearly contains a spend amount and/or food, we
//                  synthesize the expense/food candidates ourselves so trivial
//                  captures auto-apply instead of landing in "needs a look".
//   3. backdate  — salvaged candidates honour "yesterday", "last night", "on 25
//                  June" etc. so a remembered event lands on the right day.
// Pure (no DOM/Supabase) so it's tested; the edge function keeps an inline mirror.

import { looksLikeGym } from "./capture-intent.mjs";

const FOOD_MERCHANTS = [
  "zomato", "swiggy", "blinkit", "zepto", "instamart", "dominos", "domino", "mcdonald", "kfc",
  "starbucks", "subway", "pizza", "burger", "cafe", "coffee", "restaurant", "dhaba", "bakery",
  "biryani", "faasos", "eatfit", "box8", "behrouz", "wow momo", "chaayos", "haldiram", "barbeque",
];
const FOOD_WORDS = [
  "lunch", "dinner", "breakfast", "snack", "meal", "thali", "biryani", "roti", "rotis", "dal", "sabzi",
  "rice", "paneer", "egg", "eggs", "chicken", "mutton", "dosa", "idli", "poha", "sandwich", "salad",
  "shake", "smoothie", "fruit", "curd", "yogurt", "momo", "noodles", "pasta", "ate", "eaten", "food",
  "maggi", "cake", "milk", "cookies", "chai", "tea", "juice", "soup", "oats", "banana", "apple",
];

export function looksLikeFood(text = "") {
  const t = String(text).toLowerCase();
  if (FOOD_MERCHANTS.some((m) => t.includes(m))) return true;
  return FOOD_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(t));
}

// Buying provisions ("bought paneer and curd", "groceries for the week") is an
// EXPENSE, not a meal — you haven't eaten it yet. Detect that so we never log a
// grocery run as food. A clear consumption cue overrides it (you can buy a
// sandwich and eat it), so "bought lunch and ate it" still counts as a meal.
const PURCHASE_CUE = /\b(bought|buy|buying|purchas\w+|grocer\w+|stock(?:ed|ing)?\s*up)\b/i;
const FOR_LATER_CUE = /\bfor the (?:week|month|fridge|freezer|house|home|pantry)\b/i;
const CONSUMPTION_CUE = /\b(ate|eat|eaten|eating|had|having|drank|drink|drinking|consumed|breakfast|lunch|dinner|snack|brunch|supper|meal)\b/i;

export function looksLikePurchase(text = "") {
  const t = String(text).toLowerCase();
  if (CONSUMPTION_CUE.test(t)) return false;
  return PURCHASE_CUE.test(t) || FOR_LATER_CUE.test(t);
}

export function mealSlotFromTime(iso) {
  const m = String(iso).match(/T(\d{2}):/);
  const h = m ? Number(m[1]) : 12;
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 15 && h < 18) return "snack";
  if (h >= 18 && h < 23) return "dinner";
  return "other";
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
const MONEY_TRAIL = /[-–—:]\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\/?-?\s*$/;

export function extractAmount(text = "") {
  for (const rx of [MONEY_CUE, MONEY_SUFFIX, MONEY_TRAIL]) {
    const m = String(text).match(rx);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// What was the spend ON — the "on/for X" tail makes a tidy merchant label.
function spendTargetFrom(text = "") {
  const m = String(text).match(/\b(?:on|for|at)\s+(.+)$/i);
  if (!m) return null;
  return m[1].replace(MONEY_TRAIL, "").replace(/[.,!]+$/, "").trim().slice(0, 60) || null;
}

// ---- relative / explicit date resolution for salvaged candidates ----
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

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
  if (!dated) {
    mm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i)
      || (() => { const r = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i); return r ? [r[0], r[2], r[1]] : null; })();
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
  // A grocery run is an expense, not a meal — suppress all food synthesis below.
  const purchase = looksLikePurchase(evidence);
  const hasExpense = () => out.some((tc) => tc?.name === "create_expense_candidate");
  const hasFood = () => out.some((tc) => tc?.name === "create_food_log_candidate");

  // 1. Fan-out: model-emitted food-merchant expense -> matching food_log.
  //    Skipped for a grocery purchase (buying food ≠ eating it).
  if (!purchase) for (const tc of toolCalls) {
    if (tc.name !== "create_expense_candidate") continue;
    const a = tc.arguments || {};
    if (!looksLikeFood(`${a.merchant || ""} ${a.description || ""}`)) continue;
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
  if (amount != null && !hasExpense()) {
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
  //    purchase — that's an expense, not something eaten.
  if (!purchase && looksLikeFood(ev) && !hasFood()) {
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

  // 3b. A clear grocery purchase: drop any food_log (even one the model emitted) —
  //     the user bought provisions, they did not eat them. Keeps the expense.
  if (purchase) out = out.filter((tc) => tc?.name !== "create_food_log_candidate");

  // 3c. Salvage a WORKOUT the model missed: gym free-text is a workout even without
  //     the word "gym" ("did Workout A", "bench 3x10 60kg", "ran 5k", "walked 35 min").
  if (looksLikeGym(ev) && !out.some((tc) => tc?.name === "create_workout_log_candidate")) {
    out.push({
      name: "create_workout_log_candidate",
      arguments: { description: ev.replace(MONEY_TRAIL, "").trim().slice(0, 120), occurred_at: occurredAt, _auto_expanded: true },
      confidence: 0.6,
    });
  }

  // 4. Once anything real was captured, drop the now-stale review request (unless
  //    it's a genuine safety flag). This is what clears "needs a look".
  const hasWrite = out.some((tc) => typeof tc?.name === "string" && tc.name.startsWith("create_"));
  if (hasWrite) out = out.filter((tc) => tc?.name !== "request_user_review" || isSafetyReview(tc));

  return out;
}
