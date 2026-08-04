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

const FILLER = new Set(["a", "an", "the", "some", "of", "with", "and", "my", "few"]);

// Group key for "is this the same meal". Deliberately conservative: quantities are
// KEPT ("4 boiled eggs" and "6 boiled eggs" are different meals with different
// macros), only casing, punctuation and filler words are normalised away.
export function normalizeMealKey(description) {
  if (!description || typeof description !== "string") return "";
  return String(description)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ")
    .trim();
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

// The most-repeated meals with known macros, best first.
//
// Score is (times logged) with a recency multiplier, then a bonus when the group's
// usual slot matches the slot you are in right now. Something eaten 8 times but not
// for a month should not outrank something eaten 4 times this week.
export function topRepeatMeals(rows, { now = new Date(), limit = 6, minCount = 2, windowDays = 45 } = {}) {
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
      g = { key, label: String(label).trim(), count: 0, lastAt: null, slots: new Map(), samples: [] };
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

  const nowSlot = slotForHour(new Date(nowMs).getHours());

  const chips = [];
  for (const g of groups.values()) {
    if (g.count < minCount) continue;
    const slot = [...g.slots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const ageDays = g.lastAt === null ? windowDays : Math.max(0, (nowMs - g.lastAt) / 86400000);
    // Halve the weight roughly every two weeks since it was last eaten.
    const recency = 1 / (1 + ageDays / 14);
    const slotBonus = nowSlot && slot === nowSlot ? 1.35 : 1;
    chips.push({
      key: g.key,
      label: g.label,
      slot,
      count: g.count,
      lastAt: g.lastAt === null ? null : new Date(g.lastAt).toISOString(),
      score: Number((g.count * recency * slotBonus).toFixed(4)),
      calories_estimate: median(g.samples.map((s) => s.calories_estimate)),
      protein_g: median(g.samples.map((s) => s.protein_g)),
      carbs_g: median(g.samples.map((s) => s.carbs_g)),
      fat_g: median(g.samples.map((s) => s.fat_g)),
    });
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
