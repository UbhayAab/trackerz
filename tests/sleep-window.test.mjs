// Sleep window resolution + the 11-hour bug guard.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sleepWindowFromArgs, clampSleepSpan, SLEEP_MAX_HOURS } from "../lib/sleep-window.mjs";

const MORNING = "2026-07-24T08:00:00+05:30"; // a typical "slept 7h" capture time
const hoursOf = (w) => (new Date(w.ended_at) - new Date(w.started_at)) / 3600000;

// ---- shape 1: explicit window ----
const win = sleepWindowFromArgs({ started_at: "2026-07-23T23:00:00+05:30", ended_at: "2026-07-24T06:30:00+05:30" }, MORNING);
assert.equal(Math.round(hoursOf(win) * 10) / 10, 7.5);
assert.equal(win.ended_at != null, true);

// "10pm to 6am" as same-day timestamps must read as a night, not a negative span.
const wrap = sleepWindowFromArgs({ started_at: "2026-07-24T22:00:00+05:30", ended_at: "2026-07-24T06:00:00+05:30" }, MORNING);
assert.equal(Math.round(hoursOf(wrap)), 8, "same-day end rolls to next morning");

// ---- shape 2: bare duration, back-dated from the capture time ----
const dur = sleepWindowFromArgs({ hours: 7 }, MORNING);
assert.equal(Math.round(hoursOf(dur) * 10) / 10, 7);
// Ends at the capture time, starts 7h earlier - never in the future.
assert.equal(new Date(dur.ended_at).getTime() <= new Date(MORNING).getTime() + 1000, true);
assert.equal(new Date(dur.started_at) < new Date(dur.ended_at), true);

assert.equal(Math.round(hoursOf(sleepWindowFromArgs({ hours: 6.5 }, MORNING)) * 10) / 10, 6.5);

// ---- shape 2b: start + duration ----
const startDur = sleepWindowFromArgs({ started_at: "2026-07-23T23:30:00+05:30", hours: 7 }, MORNING);
assert.equal(Math.round(hoursOf(startDur) * 10) / 10, 7);

// ---- shape 3: open bedtime marker ----
const open = sleepWindowFromArgs({ started_at: "2026-07-23T23:30:00+05:30" }, MORNING);
assert.equal(open.ended_at, null, "a bedtime-only marker stays open");
assert.ok(open.started_at);

// No usable input: bedtime = capture time, left open.
const bare = sleepWindowFromArgs({}, MORNING);
assert.equal(bare.ended_at, null);
assert.equal(bare.started_at, new Date(MORNING).toISOString());

// ---- capping: the 11-hour bug ----
// A duration a human would never sleep is capped and flagged, never asserted.
const tooLong = sleepWindowFromArgs({ hours: 20 }, MORNING);
assert.equal(Math.round(hoursOf(tooLong)), SLEEP_MAX_HOURS);
assert.ok(/capped/i.test(tooLong.note || ""), "an over-long duration is flagged approximate");

const longWindow = sleepWindowFromArgs({ started_at: "2026-07-23T20:00:00+05:30", ended_at: "2026-07-24T18:00:00+05:30" }, MORNING);
assert.equal(Math.round(hoursOf(longWindow)), SLEEP_MAX_HOURS, "a 22h window is capped to the max");
assert.ok(/capped/i.test(longWindow.note || ""));

// ---- clampSleepSpan (the button path) ----
// The exact production case: bed 11:55pm, tapped "woke up" at 10:59am = 11h.
// 11h is PLAUSIBLE (some nights are long), so it is stored as-is, not capped -
// the wake-time adjuster is what corrects an 11h that should have been 7h. The
// cap is only a backstop against the absurd (a tap a full day late).
const bug = clampSleepSpan("2026-07-23T23:55:00+05:30", "2026-07-24T10:59:00+05:30");
assert.equal(bug.hours, 11.1, "an 11h span is stored, not silently rewritten");
assert.equal(bug.capped, false);

// Adjusting the wake time to 7am gives the real 7h - this is the fix path.
const fixed = clampSleepSpan("2026-07-23T23:55:00+05:30", "2026-07-24T07:00:00+05:30");
assert.equal(fixed.hours, 7.1);
assert.equal(fixed.capped, false);

// A tap a full day late IS absurd and gets capped + flagged.
const absurd = clampSleepSpan("2026-07-23T23:00:00+05:30", "2026-07-24T21:00:00+05:30");
assert.equal(absurd.hours, SLEEP_MAX_HOURS, "a 22h span is capped");
assert.equal(absurd.capped, true);
assert.equal(new Date(absurd.ended_at) < new Date("2026-07-24T21:00:00+05:30"), true, "capped end pulled earlier");

// A normal night is untouched (hours rounded to 1 decimal).
const normal = clampSleepSpan("2026-07-23T23:30:00+05:30", "2026-07-24T06:30:00+05:30");
assert.equal(normal.hours, 7);
assert.equal(normal.capped, false);

// A wake time before bedtime is not a valid span.
assert.equal(clampSleepSpan("2026-07-24T06:00:00+05:30", "2026-07-24T05:00:00+05:30").hours, null);
assert.equal(clampSleepSpan("2026-07-24T06:00:00+05:30", null).hours, null);

console.log("sleep-window tests passed");
