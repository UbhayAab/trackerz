import assert from "node:assert/strict";
import {
  addDays, buildDayStrip, clampToToday, dayDotState, dayKeyOf, dayLabel,
  isSameDay, loggedDayKeys, parseDayKey, startOfLocalDay,
  stripScrollLeftFor,
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

// --- the strip that slid a week backwards ------------------------------------
//
// Reported from the phone: "I click on the twenty third, it goes back to the
// sixteenth. When I am on the twenty third it shows me the content of the twenty
// third, but the slider itself slides back to the sixteenth."
//
// The page was never wrong. The strip is rebuilt by innerHTML on every render,
// and a rebuilt element starts at scrollLeft 0 - which on a phone shows the
// OLDEST seven of the fourteen chips. Its right-hand edge was the 16th.
{
  // The real geometry: 14 chips at 46px + 6px gap = 728px of content in a 390px
  // phone viewport, with the 23rd (today) as the last chip.
  const CHIP = 46, GAP = 6, STEP = CHIP + GAP;
  const content = 14 * STEP - GAP; // no trailing gap
  const view = 390;
  const indexOf = (dom) => 13 - (23 - dom); // 23rd is index 13
  const startOf = (dom) => indexOf(dom) * STEP;

  // Where the user was left: freshly rebuilt strip, scrollLeft 0.
  const selected23 = startOf(23);
  const fixed = stripScrollLeftFor({
    chipStart: selected23, chipWidth: CHIP, scrollLeft: 0,
    viewportWidth: view, contentWidth: content,
  });
  assert.ok(fixed != null, "a selected chip off the right edge must be scrolled to");

  // The 23rd is now genuinely on screen...
  assert.ok(selected23 >= fixed && selected23 + CHIP <= fixed + view,
    `the 23rd must be visible after the fix (chip ${selected23}, view ${fixed}..${fixed + view})`);
  // ...and the 16th is NOT the right-hand edge any more, which is the whole bug.
  // (It stays partly visible at the LEFT edge, because the strip cannot scroll
  // past its own end - that is correct, and not what was reported.)
  const lastVisibleAt = (left) => {
    let last = null;
    for (let dom = 10; dom <= 23; dom++) if (startOf(dom) >= left && startOf(dom) + CHIP <= left + view) last = dom;
    return last;
  };
  assert.equal(lastVisibleAt(fixed), 23,
    "after the fix the right-hand edge is the day being viewed, not the 16th");
  // Never past the end of the content.
  assert.ok(fixed <= content - view, "must not scroll past the end of the strip");

  // Proof of the diagnosis: at scrollLeft 0 the last fully visible chip really
  // was the 16th. If this ever stops being true the bug report stops matching.
  let lastVisible = null;
  for (let dom = 10; dom <= 23; dom++) if (startOf(dom) + CHIP <= view) lastVisible = dom;
  assert.equal(lastVisible, 16,
    "at scrollLeft 0 the right-hand edge is the 16th - the reported symptom");

  // IDEMPOTENT. Renders here are frequent (reconcile, presence refresh, fresh
  // app state); a function that always returned a number would fight the user's
  // own scrolling on every one of them.
  assert.equal(stripScrollLeftFor({
    chipStart: selected23, chipWidth: CHIP, scrollLeft: fixed,
    viewportWidth: view, contentWidth: content,
  }), null, "an already-visible chip must not be scrolled again");

  // A chip the user can already see is left alone even mid-strip.
  assert.equal(stripScrollLeftFor({
    chipStart: startOf(12), chipWidth: CHIP, scrollLeft: 0,
    viewportWidth: view, contentWidth: content,
  }), null, "a chip already on screen needs no scroll");

  // A chip off the LEFT edge scrolls back too (stepping backwards through days).
  const back = stripScrollLeftFor({
    chipStart: startOf(11), chipWidth: CHIP, scrollLeft: 400,
    viewportWidth: view, contentWidth: content,
  });
  assert.ok(back != null && back < 400, "a chip off the left edge scrolls left");
  assert.ok(back >= 0, "never scrolls to a negative offset");

  // Desktop: the whole strip fits, so nothing should ever move.
  assert.equal(stripScrollLeftFor({
    chipStart: startOf(23), chipWidth: CHIP, scrollLeft: 0,
    viewportWidth: 1200, contentWidth: content,
  }), null, "a strip that fits its viewport never scrolls");

  // Garbage in (an element not laid out yet reports 0/NaN) - do nothing rather
  // than jumping the strip to an arbitrary place.
  assert.equal(stripScrollLeftFor({
    chipStart: NaN, chipWidth: CHIP, scrollLeft: 0,
    viewportWidth: view, contentWidth: content,
  }), null, "unmeasured geometry must not move the strip");
}
