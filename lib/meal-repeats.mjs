// ONE-TAP REPEAT MEALS - the answer to "why am I typing the same meal every day".
//
// The user eats a small rotating set of things: boiled eggs, egg curry and rotis,
// idlis with sambar. Each one currently costs a typed sentence plus a 5-15s model
// round-trip that re-estimates macros it already estimated last week. This module
// turns the food rows the app ALREADY has into a ranked chip list, so the repeat
// case is one tap and zero tokens.
//
// Pure: no DOM, no Supabase, no clock reads except the `now` you pass in.
//
// Two rules that keep this honest:
//   1. A group is only offered if its macros are actually KNOWN. Re-logging a row
//      with NULL calories would recreate the exact bug this codebase keeps hitting:
//      absent data written as if it were measured.
//   2. The macros on a chip are the MEDIAN of that group's history, not the mean.
//      One mis-parsed 3000 kcal outlier must not poison the chip you tap daily.

import { mealSlotFromTime } from "./fan-out-expander.mjs";
import { FOOD_TABLE, estimateNutrition } from "./food-nutrition.mjs";
import { hourInTz, dayKeyInTz, DEFAULT_TZ } from "./tz.mjs";

const FILLER = new Set(["a", "an", "the", "some", "of", "with", "and", "my", "few"]);

const ENTRY_BY_KEY = new Map(FOOD_TABLE.map((e) => [e.key, e]));
const ALIASES_BY_KEY = new Map(FOOD_TABLE.map((e) => [e.key, new Set(e.aliases || [])]));

// estimateNutrition walks the whole alias table, and both the grouping pass and
// the combination pass want the same answer for the same sentence. Parse once.
const parseCache = new Map();
function parseFoods(text) {
  const t = String(text || "").trim();
  if (!t) return { items: [], unknown: [] };
  let hit = parseCache.get(t);
  if (!hit) {
    const r = estimateNutrition(t);
    hit = { items: r.items, unknown: r.unknown };
    if (parseCache.size > 800) parseCache.clear();
    parseCache.set(t, hit);
  }
  return hit;
}

function wordKey(description) {
  return String(description)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ")
    .trim();
}

// Group key for "is this the same meal".
//
// This used to be the SENTENCE with casing, punctuation and nine filler words
// stripped - which quietly assumed the owner types a meal the same way twice. He
// does not. Measured on his real food_logs on 2026-08-08: "6 boiled eggs" (10
// rows) and "6 whole boiled eggs" (2 rows) were two separate groups burning two
// of the five chip slots on one meal, and the soya-and-oats dinner he ate three
// nights running was three groups of one, so it could never reach minCount and
// never appeared. A text key cannot see that those are the same food.
//
// So the key is now the FOOD CONTENT, resolved through the app's own food
// vocabulary (food-nutrition.mjs): a sorted list of canonical `key:qty` pairs.
// "6 boiled eggs" and "6 whole boiled eggs" both become "egg:6"; "70g soya bean"
// and "70 g soya chunks" both become "soya chunks:0.7".
//
// Still deliberately conservative in the two ways that matter:
//   - quantities are KEPT, so "4 boiled eggs" and "6 boiled eggs" stay different
//     meals with different macros, exactly as before;
//   - anything the table does NOT recognise stays in the key as a raw token, so
//     a meal with an extra unknown food is not silently merged into one without
//     it. A description with no recognised food at all falls back to the old
//     text key, so nothing that used to group stops grouping.
export function normalizeMealKey(description) {
  if (!description || typeof description !== "string") return "";
  const words = wordKey(description);
  if (!words) return "";
  const { items, unknown } = parseFoods(description);
  if (!items.length) return words;
  const foods = items.map((i) => `${i.key}:${i.qty}`).sort();
  const rest = [...new Set(unknown)].sort();
  return [...foods, ...rest].join(" ");
}

// The meal slot a given hour belongs to, so the chip row can lead with what you
// are plausibly eating right now instead of a fixed order.
//
// RANKING ONLY. Its bands are deliberately looser than the canonical
// mealSlotFromTime in fan-out-expander.mjs (dinner starts at 16 here so the
// evening chips surface early). Never use it for the slot WRITTEN to a row -
// rowForRepeat below uses the canonical function, so the two cannot drift.
export function slotForHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return null;
  if (h >= 4 && h < 11) return "breakfast";
  if (h >= 11 && h < 16) return "lunch";
  if (h >= 16 && h < 22) return "dinner";
  return "snack";
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round(((xs[mid - 1] + xs[mid]) / 2) * 100) / 100;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A row can only seed a chip if we know what re-logging it would mean.
// Calories are the floor: a chip with no calories is a row that would land in the
// day's totals as a silent zero.
function macrosOf(row) {
  const cal = num(row.calories_estimate);
  if (cal === null || cal <= 0) return null;
  return {
    calories_estimate: cal,
    protein_g: num(row.protein_g),
    carbs_g: num(row.carbs_g),
    fat_g: num(row.fat_g),
  };
}

// ---------------------------------------------------------------------------
// STAPLE COMBINATIONS
//
// The repeat groups above only fire when a whole meal recurs. That misses the way
// the owner actually eats a staple, and it is the exact complaint that produced
// this code: he had soya chunks with oats for dinner on 5, 6 and 7 August 2026 and
// no chip ever appeared, because the three rows read
//
//   "70 g soya chunks (soaked in water, drained) + 50 g Saffola tomato oats + ..."
//   "70g soya bean, 50g oats"
//   "Paneer 200 g, soya chunks 30 g, oats 30 g, peanuts (small handful), sambar"
//
// Three different sentences, three different FOOD SETS - the accompaniments moved
// every night. Nothing that compares whole meals can see the habit. What repeated
// was the PAIR: soya chunks and oats, three nights running.
//
// So: find the food combinations that recur across distinct DAYS (a thing eaten
// twice in one day is one day of evidence, not two), keep the most specific ones,
// and price them from the food table at the quantities he actually used.
//
// The honesty rule from the top of this file still binds, and harder. A combo chip
// is only offered if the table can FULLY price the exact text the chip carries -
// the text is re-parsed and its macros must come back recognized, with the same
// foods. Nothing here is allowed to invent a number.

function combinations(arr, size) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === size) { out.push(acc.slice()); return; }
    for (let i = start; i < arr.length; i += 1) { acc.push(arr[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

// "70 g soya chunks", "40 g oats", "6 eggs" - a phrase the food table can read
// back. The round-trip below is what keeps the macros honest, so this only has to
// be parseable and readable, not clever.
function describeFood(key, qty) {
  const e = ENTRY_BY_KEY.get(key);
  if (!e) return null;
  if (e.kind === "gram") {
    const g = Math.round(qty * (e.per || 100));
    return g > 0 ? `${g} g ${key}` : null;
  }
  if (e.kind === "ml") {
    const ml = Math.round(qty * (e.per || 250));
    return ml > 0 ? `${ml} ml ${key}` : null;
  }
  const n = Math.max(1, Math.round(qty));
  // Only pluralise when the plural is a word the table already knows, so the
  // label stays readable without risking a form the parser cannot match back.
  const plural = `${key}s`;
  const word = n !== 1 && ALIASES_BY_KEY.get(key)?.has(plural) ? plural : key;
  return `${n} ${word}`;
}

// Food combinations eaten on `minDays` or more distinct days, most specific first.
//
// Returned chips carry `days` (distinct days seen) and `kind: "combo"` so a caller
// can say WHY it is offering this, which is the difference between a suggestion and
// a guess.
//
// minFoods is 2 on purpose. A single food is not a combination, and if one food
// really is the whole meal it already arrives as a verbatim repeat chip with the
// macros he was actually served. Allowing singles here measurably made things
// worse: on the owner's real history it produced "3 curd", "2 whey scoop" and
// "6 eggs" as their own chips, which are thinner restatements of meals already on
// the row, and they outranked the soya-and-oats pair purely on day count.
export function topStapleCombos(rows, {
  now = new Date(), limit = 4, minDays = 3, minFoods = 2, maxFoods = 3, windowDays = 21, timeZone = DEFAULT_TZ,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const cutoff = nowMs - windowDays * 86400000;
  const combos = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const label = row.description || row.meal_name;
    if (!label || typeof label !== "string") continue;
    const at = row.occurred_at ? new Date(row.occurred_at).getTime() : null;
    if (at === null || !Number.isFinite(at) || at < cutoff) continue;

    const { items } = parseFoods(label);
    // A meal naming a dozen things is a restaurant order, not a staple, and the
    // subset explosion is not worth paying for.
    if (!items.length || items.length > 8) continue;
    const qtyByKey = new Map(items.map((i) => [i.key, i.qty]));
    const keys = [...qtyByKey.keys()].sort();
    const dayKey = dayKeyInTz(at, timeZone);

    for (let size = Math.max(1, minFoods); size <= Math.min(maxFoods, keys.length); size += 1) {
      for (const combo of combinations(keys, size)) {
        const ck = combo.join("\u0000");
        let g = combos.get(ck);
        if (!g) {
          g = { keys: combo, days: new Set(), lastAt: null, slots: new Map(), qtys: new Map() };
          combos.set(ck, g);
        }
        g.days.add(dayKey);
        if (g.lastAt === null || at > g.lastAt) g.lastAt = at;
        if (row.meal_slot) g.slots.set(row.meal_slot, (g.slots.get(row.meal_slot) || 0) + 1);
        for (const k of combo) {
          if (!g.qtys.has(k)) g.qtys.set(k, []);
          g.qtys.get(k).push(qtyByKey.get(k));
        }
      }
    }
  }

  const kept = [...combos.values()].filter((g) => g.days.size >= minDays);

  // Closed itemsets: if soya-and-oats was eaten on the same three days as soya
  // alone, "soya" carries no information the pair does not, so drop it. A food
  // that also shows up on days the pair does not (oats on its own) survives,
  // because its higher day count is a different, true fact.
  const survivors = kept.filter((g) => !kept.some((other) => (
    other !== g
    && other.keys.length > g.keys.length
    && other.days.size === g.days.size
    && g.keys.every((k) => other.keys.includes(k))
  )));

  const nowSlot = slotForHour(hourInTz(nowMs, timeZone));
  const chips = [];
  for (const g of survivors) {
    const parts = [];
    let bad = false;
    for (const k of g.keys) {
      const text = describeFood(k, median(g.qtys.get(k)) ?? 1);
      if (!text) { bad = true; break; }
      parts.push({ key: k, text });
    }
    if (bad) continue;

    // Lead with the food that carries the meal. Priced individually so the order
    // is a fact about the plate, not the order the parser happened to emit.
    for (const p of parts) p.kcal = estimateNutrition(p.text).totals.calories;
    parts.sort((a, b) => b.kcal - a.kcal || a.key.localeCompare(b.key));
    const label = parts.map((p) => p.text).join(" + ");

    // THE HONESTY GATE. The chip's own text is priced from scratch; if the table
    // cannot fully recognise it, or it reads back as different foods, the chip is
    // dropped rather than shipped with a number nobody measured.
    const priced = estimateNutrition(label);
    if (!priced.recognized) continue;
    const back = priced.items.map((i) => i.key).sort();
    if (back.length !== g.keys.length || back.some((k, i) => k !== g.keys[i])) continue;
    if (!(priced.totals.calories > 0)) continue;

    const slot = [...g.slots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const ageDays = Math.max(0, (nowMs - g.lastAt) / 86400000);
    const recency = 1 / (1 + ageDays / 14);
    const slotBonus = nowSlot && slot === nowSlot ? 1.35 : 1;
    // A pair says more about a habit than a single ingredient does, so it gets a
    // small specificity edge at equal day counts. Nothing bigger: the day count is
    // the evidence, this is only a tie-break.
    const specificity = 1 + 0.2 * (g.keys.length - 1);
    chips.push({
      kind: "combo",
      key: `combo:${g.keys.join("+")}`,
      label,
      foods: g.keys.slice(),
      slot,
      days: g.days.size,
      count: g.days.size,
      lastAt: new Date(g.lastAt).toISOString(),
      score: Number((g.days.size * recency * slotBonus * specificity).toFixed(4)),
      calories_estimate: priced.totals.calories,
      protein_g: priced.totals.protein_g,
      carbs_g: priced.totals.carbs_g,
      fat_g: priced.totals.fat_g,
    });
  }

  chips.sort((a, b) => b.score - a.score || b.days - a.days || a.label.localeCompare(b.label));
  return chips.slice(0, Math.max(0, limit));
}

// The most-repeated meals with known macros, best first.
//
// Score is (times logged) with a recency multiplier, then a bonus when the group's
// usual slot matches the slot you are in right now. Something eaten 8 times but not
// for a month should not outrank something eaten 4 times this week.
//
// Two sources feed the list: whole meals that recur verbatim (grouped by food
// content, see normalizeMealKey) and staple COMBINATIONS that recur across days
// even when the rest of the plate changes. A combination is dropped when a verbatim
// chip already covers exactly the same foods, so the same meal is never offered
// twice.
export function topRepeatMeals(rows, {
  now = new Date(), limit = 6, minCount = 2, windowDays = 45, timeZone = DEFAULT_TZ,
  combos = true, minComboDays = 3, comboWindowDays = 21,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const cutoff = nowMs - windowDays * 86400000;
  const groups = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const label = row.description || row.meal_name;
    const key = normalizeMealKey(label);
    if (!key) continue;
    const macros = macrosOf(row);
    if (!macros) continue;
    const at = row.occurred_at ? new Date(row.occurred_at).getTime() : null;
    if (at !== null && Number.isFinite(at) && at < cutoff) continue;

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label: String(label).trim(),
        count: 0,
        lastAt: null,
        slots: new Map(),
        samples: [],
        foods: parseFoods(label).items.map((i) => i.key).sort(),
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.samples.push(macros);
    if (at !== null && Number.isFinite(at) && (g.lastAt === null || at > g.lastAt)) {
      g.lastAt = at;
      // Keep the most recent spelling as the display label - it is the one the
      // user most recently chose to call it.
      g.label = String(label).trim();
    }
    if (row.meal_slot) g.slots.set(row.meal_slot, (g.slots.get(row.meal_slot) || 0) + 1);
  }

  // hourInTz, NOT Date#getHours. getHours reads the HOST's clock: correct in the
  // owner's browser, five and a half hours out in a Deno edge function or in CI,
  // which silently reorders the chips the server-side surfaces offer. The slot
  // written to the row already went through the tz-aware mealSlotFromTime; this
  // is the last place in the module that still asked the machine what time it is.
  const nowSlot = slotForHour(hourInTz(nowMs, timeZone));

  const chips = [];
  for (const g of groups.values()) {
    if (g.count < minCount) continue;
    const slot = [...g.slots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const ageDays = g.lastAt === null ? windowDays : Math.max(0, (nowMs - g.lastAt) / 86400000);
    // Halve the weight roughly every two weeks since it was last eaten.
    const recency = 1 / (1 + ageDays / 14);
    const slotBonus = nowSlot && slot === nowSlot ? 1.35 : 1;
    chips.push({
      kind: "repeat",
      key: g.key,
      label: g.label,
      foods: g.foods,
      slot,
      count: g.count,
      days: null,
      lastAt: g.lastAt === null ? null : new Date(g.lastAt).toISOString(),
      score: Number((g.count * recency * slotBonus).toFixed(4)),
      calories_estimate: median(g.samples.map((s) => s.calories_estimate)),
      protein_g: median(g.samples.map((s) => s.protein_g)),
      carbs_g: median(g.samples.map((s) => s.carbs_g)),
      fat_g: median(g.samples.map((s) => s.fat_g)),
    });
  }

  if (combos) {
    // A combination whose foods are already covered exactly by a whole-meal chip
    // is the same suggestion said twice - the verbatim chip wins, because its
    // macros are what he was actually served rather than a table reconstruction.
    const covered = new Set(chips.map((c) => (c.foods || []).join("+")).filter(Boolean));
    const extra = topStapleCombos(rows, {
      now, limit: Math.max(0, limit), minDays: minComboDays, windowDays: comboWindowDays, timeZone,
    });
    for (const c of extra) if (!covered.has(c.foods.join("+"))) chips.push(c);
  }

  chips.sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label));
  return chips.slice(0, Math.max(0, limit));
}

// The food_logs row a chip tap should write. Separated from the UI so the shape is
// testable.
//
// confidence 1 is deliberate and it is NOT the model's confidence: the user tapped a
// meal they have eaten before, so the fact is asserted, not inferred. The macros are
// the median of that meal's own history, so they are as good as the day they were
// first estimated.
//
// NOTE: food_logs has no source_type column (unlike ledger_entries), so a repeat tap
// is currently indistinguishable at the row level from an AI-estimated meal. That is
// a real gap for duplicate detection and is tracked separately - do not "fix" it here
// by inventing a column that does not exist, the insert would fail.
export function rowForRepeat(chip, { now = new Date() } = {}) {
  if (!chip || !chip.label) return null;
  return {
    description: chip.label,
    // The CLOCK, not chip.slot. chip.slot is the meal's most common historical
    // slot and belongs to ranking - using it for the row meant tapping "6 boiled
    // eggs" at 10:49 IST wrote "lunch" because that is when those eggs usually
    // happen. A quick-add tap is a record of eating right now, and unlike the AI
    // path there is no model judgement here worth preserving. Measured
    // 2026-08-04: this path was the last one still disagreeing with the clock
    // after the agent-side fix landed.
    meal_slot: mealSlotFromTime(now.toISOString()),
    calories_estimate: chip.calories_estimate,
    protein_g: chip.protein_g,
    carbs_g: chip.carbs_g,
    fat_g: chip.fat_g,
    occurred_at: now.toISOString(),
    confidence: 1,
  };
}
