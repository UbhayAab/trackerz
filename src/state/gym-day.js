// Which day of the Home Protocol rotation is being trained today.
//
// The rotation is date-driven: Monday is A, Sunday is R (PROTOCOL_BY_WEEKDAY).
// That is deliberate - a self-advancing counter drifts away from the calendar,
// and then the morning brief, the diet page and the gym panel each believe in a
// different "today", which is the one failure this app keeps being punished for.
//
// But real weeks bend. You miss Tuesday and want B on Wednesday. So a calendar
// day can carry ONE override, stored per day, never as a rolling offset: it says
// "today I trained C", it does not silently rewrite every day after it. Tomorrow
// still resolves from the calendar.
//
// This lives in state/ rather than inside the panel because two surfaces read it
// - the gym page header and the per-exercise log - and a header that disagrees
// with the checklist under it is the same bug in a smaller font.

import { planForDate } from "../domain/diet/plan.js";
import { protocolDay, PROTOCOL_LETTERS } from "../../lib/home-protocol.mjs";

const PREFIX = "trackerz.gym.rotation.v1.";

// Private mode, a full quota, or no browser at all (tests). The choice still has
// to take effect for this page, so it is held in memory and the UI is told the
// storage is memory-only rather than being left to imply it will still be there
// tomorrow.
const memory = new Map();
let memoryOnly = false;

export function rotationIsMemoryOnly() { return memoryOnly; }

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readStored(key) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    if (v != null) return v;
  } catch (err) {
    memoryOnly = true;
  }
  return memory.get(key) ?? null;
}

function writeStored(key, value) {
  if (value == null) memory.delete(key); else memory.set(key, value);
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
    return true;
  } catch (err) {
    memoryOnly = true;
    return false;
  }
}

// The letter the calendar prescribes, with no override applied.
export function scheduledLetter(date = new Date()) {
  const workout = planForDate(date).workout;
  return workout?.letter || null;
}

export function selectedLetter(date = new Date()) {
  const stored = readStored(PREFIX + dayKey(date));
  if (stored && PROTOCOL_LETTERS.includes(stored)) return stored;
  return scheduledLetter(date);
}

export function setSelectedLetter(letter, date = new Date()) {
  const next = String(letter || "").toUpperCase();
  if (!PROTOCOL_LETTERS.includes(next)) return;
  // Choosing the day the calendar already prescribes clears the override rather
  // than pinning it, so tomorrow resolves normally.
  writeStored(PREFIX + dayKey(date), next === scheduledLetter(date) ? null : next);
}

// The workout to show and log against: the override when there is one, otherwise
// whatever the plan resolver said (which is also where a user_plans override for
// this date, if any, has already been folded in).
export function workoutForToday(date = new Date()) {
  const plan = planForDate(date);
  const letter = selectedLetter(date);
  const swapped = letter && letter !== plan.workout?.letter ? protocolDay(letter) : null;
  if (!swapped) return { workout: plan.workout, letter: plan.workout?.letter || null, swapped: false, plan };
  return {
    // protocolDay() is the raw program day; give it the same shape the plan
    // resolver hands out so every consumer stays on one contract.
    workout: {
      id: swapped.id, name: swapped.name, letter: swapped.letter, kind: swapped.kind,
      duration_min: swapped.duration_min, focus: swapped.focus, rest: Boolean(swapped.rest),
      items: swapped.exercises.map((e) => (e.repsLabel ? `${e.name} ${e.sets}x${e.repsLabel}` : e.name)),
      exercises: swapped.exercises, rules: swapped.rules,
    },
    letter: swapped.letter,
    swapped: true,
    plan,
  };
}
