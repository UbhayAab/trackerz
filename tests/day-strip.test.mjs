import assert from "node:assert/strict";
import {
  addDays, buildDayStrip, clampToToday, dayDotState, dayKeyOf, dayLabel,
  isSameDay, loggedDayKeys, parseDayKey, startOfLocalDay,
} from "../lib/day-strip.mjs";

const today = new Date(2026, 6, 22, 15, 30); // 22 Jul 2026, local

// --- keys are LOCAL, not UTC -------------------------------------------------
assert.equal(dayKeyOf(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
assert.equal(dayKeyOf(new Date(2026, 11, 31, 0, 1)), "2026-12-31");

// A late-evening IST timestamp must stay on its own local day (the UTC key would
// be the day before for anything past 05:30 IST offset boundaries).
const lateNight = new Date(2026, 6, 22, 23, 45);
assert.equal(dayKeyOf(lateNight), "2026-07-22");

// --- parseDayKey round-trips through local midnight --------------------------
const parsed = parseDayKey("2026-07-20");
assert.equal(dayKeyOf(parsed), "2026-07-20");
assert.equal(parsed.getHours(), 0);
assert.equal(parseDayKey(""), null);
assert.equal(parseDayKey("20-07-2026"), null);
assert.equal(parseDayKey("2026-02-31"), null, "impossible date must not roll over silently");
assert.equal(parseDayKey(null), null);

// --- no future ---------------------------------------------------------------
assert.equal(dayKeyOf(clampToToday(new Date(2026, 6, 25), today)), "2026-07-22");
assert.equal(dayKeyOf(clampToToday(new Date(2026, 6, 20), today)), "2026-07-20");
// Clamping today's own afternoon returns today at midnight, not tomorrow.
assert.equal(dayKeyOf(clampToToday(today, today)), "2026-07-22");

// --- strip shape -------------------------------------------------------------
const strip = buildDayStrip(today, 14);
assert.equal(strip.length, 14);
assert.equal(strip[13].key, "2026-07-22", "today is last (right edge)");
assert.equal(strip[0].key, "2026-07-09", "14 days back inclusive");
assert.equal(strip[13].isToday, true);
assert.equal(strip[12].isToday, false);
assert.equal(strip[13].dom, 22);
assert.equal(strip[13].offset, 0);
assert.equal(strip[12].offset, -1);
assert.ok(strip.every((d) => d.dow && d.month));
// Never emits a future day.
assert.ok(strip.every((d) => startOfLocalDay(d.date) <= startOfLocalDay(today)));
// Degenerate counts still produce a usable strip.
assert.equal(buildDayStrip(today, 0).length, 1);
assert.equal(buildDayStrip(today, 1)[0].key, "2026-07-22");

// --- presence folding --------------------------------------------------------
const food = [
  { occurred_at: new Date(2026, 6, 22, 13, 5).toISOString() },
  { occurred_at: new Date(2026, 6, 20, 21, 0).toISOString() },
  { occurred_at: null },            // no timestamp -> cannot be placed on a day
  { occurred_at: "not-a-date" },    // garbage -> ignored, never marks a day
];
const workouts = [{ occurred_at: new Date(2026, 6, 18, 7, 0).toISOString() }];
const presence = loggedDayKeys([food, workouts, null]);
assert.deepEqual([...presence].sort(), ["2026-07-18", "2026-07-20", "2026-07-22"]);
assert.equal(presence.size, 3, "undated/garbage rows must not invent a logged day");

// --- the defining rule: unknown != empty -------------------------------------
assert.equal(dayDotState("2026-07-22", presence), "logged");
assert.equal(dayDotState("2026-07-21", presence), "empty");
assert.equal(dayDotState("2026-07-21", null), "unknown");
assert.equal(dayDotState("2026-07-21", undefined), "unknown");
assert.notEqual(dayDotState("2026-07-21", null), dayDotState("2026-07-21", presence));

// --- labels ------------------------------------------------------------------
assert.equal(dayLabel(today, today), "Today");
assert.equal(dayLabel(addDays(today, -1), today), "Yesterday");
assert.ok(/20/.test(dayLabel(new Date(2026, 6, 20), today)));
assert.ok(!/Today|Yesterday/.test(dayLabel(new Date(2026, 6, 20), today)));

// --- misc --------------------------------------------------------------------
assert.equal(isSameDay(new Date(2026, 6, 22, 1), new Date(2026, 6, 22, 23)), true);
assert.equal(isSameDay(new Date(2026, 6, 22), new Date(2026, 6, 23)), false);
assert.equal(dayKeyOf(addDays(new Date(2026, 6, 31), 1)), "2026-08-01", "month rollover");
assert.equal(dayKeyOf(addDays(new Date(2026, 0, 1), -1)), "2025-12-31", "year rollback");

console.log("day-strip tests passed");
