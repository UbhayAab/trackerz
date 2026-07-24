// Turns however sleep was reported into a concrete { started_at, ended_at }.
//
// The whole point is forgiveness: nobody remembers the exact minute they fell
// asleep, and the "Sleeping / Woke up" buttons record wall-clock, so a late
// morning tap logged an 11-hour night. Typing "slept 7h" or "woke up at 7"
// should Just Work, and an implausibly long span is capped and FLAGGED as
// approximate rather than asserted as fact - reporting a sleep figure the app is
// not sure of is the same class of bug as reporting zero sleep it never had.
//
// Three input shapes:
//   1. { started_at, ended_at }         -> used as given (validated + capped)
//   2. { hours }                        -> a duration, anchored to the capture
//                                          time (usually morning) and back-dated
//   3. { started_at } only              -> "going to bed now", left open
//
// Pure (no DOM/Supabase/Deno) so it is unit-tested; the agent edge function and
// the client applier both mirror it. tests/sleep-window.test.mjs guards parity.

// ==== SLEEP-WINDOW MIRROR START (byte-identical in supabase/functions/agent/index.ts + src/services/action-applier.js) ====
var SLEEP_MAX_HOURS = 16;   // a longer span almost certainly means a forgotten tap
var SLEEP_MIN_HOURS = 0.25; // 15 min: below this it is a mis-tap, not sleep

function swParseIso(value) {
  if (!value) return null;
  var t = new Date(value).getTime();
  return isFinite(t) ? t : null;
}

function swToIso(ms) {
  return new Date(ms).toISOString();
}

function swNum(v) {
  var n = Number(v);
  return isFinite(n) ? n : null;
}

// Resolve the sleep window. `now` is the anchor for a bare duration - the edge
// function passes the capture's occurred_at, so "slept 7h" logged this morning
// back-dates into last night, not into the future.
function sleepWindowFromArgs(args, now) {
  var a = args || {};
  var anchorMs = swParseIso(now) || swParseIso(a.occurred_at) || Date.now();

  var startMs = swParseIso(a.started_at);
  var endMs = swParseIso(a.ended_at);
  var hours = swNum(a.hours);

  var note = a.note || null;

  // Shape 1: an explicit window.
  if (startMs != null && endMs != null) {
    if (endMs <= startMs) {
      // "10pm to 6am" can arrive as same-day timestamps; assume the end is the
      // next morning rather than a negative night.
      endMs += 24 * 3600 * 1000;
    }
    var span = (endMs - startMs) / 3600000;
    if (span > SLEEP_MAX_HOURS) {
      endMs = startMs + SLEEP_MAX_HOURS * 3600000;
      note = swAppendNote(note, "capped at " + SLEEP_MAX_HOURS + "h (span looked too long)");
    }
    return { started_at: swToIso(startMs), ended_at: swToIso(endMs), note: note };
  }

  // Shape 2: a bare duration, anchored to the capture time and back-dated.
  if (hours != null && hours > 0 && startMs == null) {
    var h = hours;
    if (h > SLEEP_MAX_HOURS) {
      h = SLEEP_MAX_HOURS;
      note = swAppendNote(note, "capped at " + SLEEP_MAX_HOURS + "h");
    }
    if (h < SLEEP_MIN_HOURS) h = SLEEP_MIN_HOURS;
    var end2 = anchorMs;
    var start2 = end2 - h * 3600000;
    return { started_at: swToIso(start2), ended_at: swToIso(end2), note: note };
  }

  // Shape 2b: duration alongside an explicit start (e.g. "went to bed at 11,
  // slept 7h") - derive the end from the start.
  if (hours != null && hours > 0 && startMs != null) {
    var h2 = Math.min(hours, SLEEP_MAX_HOURS);
    return { started_at: swToIso(startMs), ended_at: swToIso(startMs + h2 * 3600000), note: note };
  }

  // Shape 3: only a start - an open "going to bed" marker, closed later.
  if (startMs != null) {
    return { started_at: swToIso(startMs), ended_at: null, note: note };
  }

  // Nothing usable: treat the capture time as bedtime, leave it open.
  return { started_at: swToIso(anchorMs), ended_at: null, note: note };
}

function swAppendNote(existing, add) {
  if (!existing) return add;
  return existing + "; " + add;
}

// Given a raw start and a raw end (both ISO), return the plausible hours and
// whether it was capped. Used by the "Woke up" button so a forgotten tap does
// not record a 14-hour night as fact.
function clampSleepSpan(startedAtIso, endedAtIso) {
  var startMs = swParseIso(startedAtIso);
  var endMs = swParseIso(endedAtIso);
  if (startMs == null || endMs == null || endMs <= startMs) {
    return { hours: null, capped: false, ended_at: endedAtIso };
  }
  var span = (endMs - startMs) / 3600000;
  if (span > SLEEP_MAX_HOURS) {
    return { hours: SLEEP_MAX_HOURS, capped: true, ended_at: swToIso(startMs + SLEEP_MAX_HOURS * 3600000) };
  }
  return { hours: Math.round(span * 10) / 10, capped: false, ended_at: endedAtIso };
}
// ==== SLEEP-WINDOW MIRROR END ====

export { sleepWindowFromArgs, clampSleepSpan, SLEEP_MAX_HOURS, SLEEP_MIN_HOURS };
