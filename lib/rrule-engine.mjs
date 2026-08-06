// RRULE ENGINE - rrule.js, the reference implementation, wearing our rule shape.
//
// WHY THIS EXISTS. lib/reminders.mjs is a hand-rolled recurrence engine. It has
// to be: it is copied byte-identically into supabase/functions/jarvis/index.ts,
// where an import is impossible, and it deliberately does integer arithmetic on
// date KEYS so no instant is ever read in the wrong zone. That is the right
// design for the hot path and the wrong design for INTEROP - the moment a rule
// leaves this app (an .ics file, a Google Calendar sync, anything a stranger's
// calendar has to agree with) the only defensible authority is the library
// everyone else already implements against.
//
// So: two engines, one truth.
//   lib/reminders.mjs  - the mirrored hot path. Zero dependencies. Fast.
//   lib/rrule-engine.mjs (this) - rrule.js. The generator for anything exported,
//                        and the CONFORMANCE ORACLE the hot path is tested
//                        against in tests/rrule-engine.test.mjs.
//
// WHO WINS A DISAGREEMENT. Not rrule.js by default - RFC 5545 by default.
// rrule.js is the INTEROP reference (2.6M npm downloads a week), not the spec,
// and it is measurably wrong about one thing this app depends on: it silently
// discards `DTSTART;VALUE=DATE`. Handed
//   DTSTART;VALUE=DATE:20260131 / RRULE:FREQ=MONTHLY;COUNT=3
// it returns three occurrences starting at the CURRENT TIMESTAMP - measured
// 2026-08-06, `options.dtstart` read back as the moment the test ran - with no
// exception. VALUE=DATE is what Google, Apple and our own exporter write for
// all-day events, so taken at face value every imported birthday re-anchors to
// the day of import. normaliseICalendar() below rewrites date-valued properties
// to the UTC-midnight DATE-TIME form rrulestr does read, which is the same
// instant our keys already mean. The project has had no merged PR since
// 2023-11-10, so this is worked around, not waited on.
//
// Everywhere else in the sweep rrule.js was right and lib/reminders.mjs was
// wrong, and every fix there is backed by RFC 5545 rather than by rrule.js
// agreeing with itself - the test names the section for each.
//
// THE ONE DELIBERATE DIVERGENCE, translated rather than papered over:
// reminders.mjs CLAMPS "the 31st" into February (rolling a tax deadline forward
// is the one direction that costs money); RFC 5545 BYMONTHDAY=31 SKIPS February.
// A clamped day is therefore emitted as the set that reproduces the clamp -
// BYMONTHDAY=28,29,30,31;BYSETPOS=-1 - which is ordinary RFC 5545 that rrule.js
// expands to our twelve dates. Nothing is hidden: the test measures the naive
// form at 7 dates a year against our 12.
//
// That string is RFC-correct and is still what this module generates. It is NOT
// what ends up in a .ics file by default, because ical.js 2.2.1 - which is what
// Thunderbird ships - ignores BYSETPOS when it is paired with BYMONTHDAY and
// expands the same rule to 38 dates a year (measured). lib/rrule-codec.mjs picks
// the dialect on that evidence; see needsClampDialect() there.
//
// THE SECOND ONE: our weeks start on SUNDAY (weekdayOf returns 0 for Sunday and
// weekIndex counts Sunday-based weeks). RFC 5545's default is WKST=MO. That only
// changes dates for INTERVAL>1 weekly rules whose weekday set straddles the week
// boundary, and it changes them a LOT - measured, "every other Sunday and
// Wednesday" from a Sunday start is 10 dates our way and 9 the RFC-default way,
// disagreeing from the second date on. So weekly rules with an interval carry an
// explicit WKST=SU. That is not a workaround, it is the RFC part whose entire
// purpose is to state this.
//
// Pure: no DOM, no Supabase, no clock. `since` is the caller's "today".
//
// It imports lib/reminders.mjs for FIELD READERS only (ruleInterval, ruleStart,
// weekdayList, dateList, ruleProblem, parseKey/toKey) - the code that decides
// what a rule SAYS. None of its occurrence arithmetic is used here, which is
// what lets the two be compared honestly.

import { RRule, RRuleSet, Weekday, rrulestr } from "../vendor/rrule/rrule@2.8.1/index.mjs";
import {
  parseKey, toKey,
  ruleInterval, ruleCount, ruleStart, weekdayList, dateList, ruleProblem,
} from "./reminders.mjs";
import { Ok, Err, unwrapOr } from "./failure.mjs";

export const RRULE_JS_VERSION = "2.8.1";

// ---------------------------------------------------------------------------
// keys <-> Dates
//
// rrule.js has no timezone of its own: it treats a Date's UTC fields as the
// wall clock and hands back Dates built the same way. So a date KEY maps to UTC
// midnight and reads back out of the UTC getters, and no local zone is ever
// consulted - the same property lib/reminders.mjs gets by never making a Date.
// ---------------------------------------------------------------------------

export function keyToDate(key) {
  const p = parseKey(key);
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)) : null;
}

export function dateToKey(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return null;
  return toKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Our weekday numbers are JavaScript's (0 = Sunday); rrule.js counts from Monday.
function rruleWeekday(wd, nth) {
  const idx = (Number(wd) + 6) % 7;
  return Number.isInteger(nth) && nth !== 0 ? new Weekday(idx, nth) : new Weekday(idx);
}

export function ourWeekday(rruleWd) {
  return (Number(rruleWd) + 1) % 7;
}

// The BYMONTHDAY set that reproduces clampDay(). BYSETPOS=-1 picks the last
// candidate that exists in the month, which IS the clamp: day 31 lands on 28/29
// in February, 30 in April, 31 everywhere else.
function clampedMonthDays(day) {
  const d = Math.max(1, Math.min(31, Math.trunc(Number(day) || 1)));
  if (d <= 28) return { bymonthday: [d], bysetpos: null };
  const days = [];
  for (let x = 28; x <= d; x++) days.push(x);
  return { bymonthday: days, bysetpos: [-1] };
}

// ---------------------------------------------------------------------------
// our parts -> an rrule.js plan
// ---------------------------------------------------------------------------

// The recurrence container, minus DTSTART and minus COUNT/UNTIL. `phaseKey` is
// the date whose PERIOD the interval counts from - not necessarily an occurrence,
// which is why it is resolved to a real one before anything is emitted.
function planFor(rule, sinceKey) {
  const freq = String(rule.freq || "").toLowerCase();
  const interval = ruleInterval(rule);
  const anchorKey = ruleStart(rule);
  const ref = parseKey(anchorKey) || parseKey(sinceKey);
  const notes = [];

  if (freq === "once") return { once: true, notes };

  if (freq === "daily") {
    if (!ref) return { error: "a daily rule needs a start date to phase from" };
    return { plan: { freq: RRule.DAILY, interval }, phaseKey: anchorKey || String(sinceKey), notes };
  }

  if (freq === "weekly") {
    if (!ref) return { error: "a weekly rule needs a start date to phase from" };
    const wds = weekdayList(rule);
    if (!wds.length) return { error: "weekly needs at least one weekday" };
    const plan = { freq: RRule.WEEKLY, interval };
    // WKST is meaningless at INTERVAL=1 (there is no "off" week to place), so it
    // is only stated where it decides something. See the header.
    if (interval > 1) plan.wkst = RRule.SU;
    plan.byweekday = wds.map((w) => rruleWeekday(w, 0));
    return { plan, phaseKey: anchorKey || String(sinceKey), notes };
  }

  if (freq !== "monthly" && freq !== "quarterly" && freq !== "yearly") {
    return { error: `cannot express freq "${rule.freq}"` };
  }

  // monthly / quarterly / yearly are one walk in months, exactly as nextRaw()
  // does it: a step size and a phase month, then a day placed inside whichever
  // month qualifies. The phase resolution below is a line-for-line translation
  // of that function's, so the two cannot disagree about WHICH months.
  const step = freq === "monthly" ? interval : (freq === "quarterly" ? 3 : 12) * interval;
  const a = parseKey(anchorKey);
  let phaseMonth = Number(rule.month_of_year);
  if (!Number.isInteger(phaseMonth) || phaseMonth < 1 || phaseMonth > 12) {
    if (freq === "monthly") phaseMonth = a ? a.m : (ref ? ref.m : 0);
    else if (a) phaseMonth = a.m;
    else return { error: "needs an anchor month" };
  }
  if (!phaseMonth) return { error: "a monthly rule needs a start date to phase from" };
  // With no dtstart the phase is a bare month-of-year, so back the reference year
  // up by one - the same trick nextRaw() uses to make a January rule reachable
  // from the previous December.
  const phaseYear = a ? a.y : ref.y - 1;
  const phaseKey = toKey(phaseYear, phaseMonth, 1);

  const nth = Number(rule.nth_weekday);
  const hasNth = Number.isInteger(nth) && nth !== 0;
  const clamp = hasNth ? null : clampedMonthDays(rule.day_of_month);
  const needsMonthPeriod = Boolean(clamp && clamp.bysetpos);

  const plan = {};
  if (freq === "yearly") {
    // One month per period, so a clamp set stays scoped to that month.
    plan.freq = RRule.YEARLY;
    plan.interval = interval;
    plan.bymonth = [phaseMonth];
  } else if (freq === "quarterly" && !needsMonthPeriod && 12 % step === 0) {
    // FREQ=YEARLY;BYMONTH=... keeps the phase inside the RULE, so a calendar
    // that rewrites DTSTART cannot shift it. Only legal while the step divides
    // the year: "every 9 months" is Jan/Oct/Jul/Apr rotating, and BYMONTH=1,10
    // would freeze it at Jan/Oct forever - measured, that is 10 wrong dates in
    // five years. Steps of 3, 6 and 12 divide; 9, 15, 18 do not.
    plan.freq = RRule.YEARLY;
    plan.interval = 1;
    plan.bymonth = [];
    for (let m = ((phaseMonth - 1) % step) + 1; m <= 12; m += step) plan.bymonth.push(m);
  } else {
    // BYSETPOS applies to the whole PERIOD, so a clamped quarterly cannot live
    // in a yearly period spanning four months - it would collapse to one date a
    // year. FREQ=MONTHLY's period is a single month, which is what the clamp
    // needs; the cost is that the phase now rides on DTSTART.
    plan.freq = RRule.MONTHLY;
    plan.interval = step;
    if (freq !== "monthly") {
      notes.push("phase is carried by DTSTART - a calendar that rewrites DTSTART will shift this rule");
    }
  }

  if (hasNth) {
    plan.byweekday = [rruleWeekday(weekdayList(rule)[0], nth)];
  } else {
    plan.bymonthday = clamp.bymonthday;
    if (clamp.bysetpos) {
      plan.bysetpos = clamp.bysetpos;
      notes.push(`day ${rule.day_of_month} is CLAMPED to the month end here; plain BYMONTHDAY=${rule.day_of_month} would skip short months entirely`);
    }
  }
  return { plan, phaseKey, notes };
}

// The options object handed to rrule.js. Key ORDER matters and is deliberate:
// RRule.optionsToString() serialises in insertion order, and this is the order
// RFC 5545's own examples read in.
function optionsFrom(plan, dtstartKey, limits) {
  const o = { freq: plan.freq };
  o.dtstart = keyToDate(dtstartKey);
  if (plan.interval > 1) o.interval = plan.interval;
  if (plan.wkst) o.wkst = plan.wkst;
  if (plan.bymonth) o.bymonth = plan.bymonth;
  if (plan.bymonthday) o.bymonthday = plan.bymonthday;
  if (plan.byweekday) o.byweekday = plan.byweekday;
  if (plan.bysetpos) o.bysetpos = plan.bysetpos;
  if (limits && limits.count != null) o.count = limits.count;
  else if (limits && limits.until) o.until = keyToDate(limits.until);
  return o;
}

/**
 * Our rule parts -> rrule.js.
 *
 * Returns { error } when the rule cannot fire at all (ruleProblem says why in
 * words) - exporting a rule that does nothing puts a dead entry in someone's
 * real calendar, and generating occurrences for one would be inventing dates.
 *
 * Otherwise: { dtstart, rrule, options, exdates, rdates, notes, once }.
 *   dtstart - the FIRST real occurrence at or after the rule's anchor, not the
 *             raw anchor. RFC 5545 leaves an unsynchronised DTSTART undefined,
 *             and it is also the floor our engine applies (nextOccurrence starts
 *             its cursor at the anchor), so anything else exports a different
 *             series than the app runs.
 *   rrule   - the RRULE line's value, generated by rrule.js itself.
 */
export function ruleToRRule(rule, { since = null } = {}) {
  rule = rule || {};
  const problem = ruleProblem(rule);
  if (problem) return { error: problem };

  const sinceKey = parseKey(since) ? String(since) : null;
  const built = planFor(rule, sinceKey);
  if (built.error) return { error: built.error };

  const exdates = dateList(rule.exdates);
  const rdates = dateList(rule.rdates);

  if (built.once) {
    // A one-off is a plain VEVENT with no RRULE. FREQ=DAILY;COUNT=1 would be the
    // same dates and a lie about the user's intent.
    return { dtstart: String(rule.on_date), rrule: "", options: null, once: true, exdates, rdates, notes: [] };
  }

  const { plan, phaseKey, notes } = built;
  const anchorKey = ruleStart(rule);
  const floorKey = anchorKey || sinceKey;

  // Synchronise DTSTART onto a real occurrence at or after the floor. Done with
  // rrule.js rather than our own nextRaw() on purpose: this module must be able
  // to disagree with lib/reminders.mjs, and it cannot if it asks it for dates.
  const phaseRule = new RRule(optionsFrom(plan, phaseKey, null));
  const firstDate = phaseRule.after(keyToDate(floorKey || phaseKey), true);
  if (!firstDate) return { error: "rule produces no dates at or after its start" };
  const dtstart = dateToKey(firstDate);

  // RFC 5545 3.3.10: COUNT and UNTIL MUST NOT both appear in one RECUR. Our rule
  // shape allows both and the engine intersects them, so emit whichever actually
  // ends the series first - which reproduces the intersection exactly rather
  // than silently dropping the tighter of the two limits.
  const count = ruleCount(rule);
  const untilKey = parseKey(rule.until) ? String(rule.until) : null;
  let limits = { count, until: untilKey };
  if (count != null && untilKey) {
    const counted = new RRule(optionsFrom(plan, dtstart, { count })).all();
    const lastCounted = counted.length ? dateToKey(counted[counted.length - 1]) : null;
    limits = (lastCounted && untilKey < lastCounted) ? { count: null, until: untilKey } : { count, until: null };
    notes.push(`COUNT and UNTIL cannot both be written to one RRULE; exported the tighter limit (${limits.count != null ? `COUNT=${limits.count}` : `UNTIL=${untilKey}`})`);
  }

  const options = optionsFrom(plan, dtstart, limits);
  const serialised = RRule.optionsToString(options).split("\n");
  const line = serialised.find((l) => l.startsWith("RRULE:"));
  // RFC 5545: UNTIL must carry the same value type as DTSTART. We export DTSTART
  // as a DATE - an all-day reminder is a calendar fact, not an instant, and a
  // DATE-TIME DTSTART would land "the 10th" at 05:30 IST - so UNTIL has to be a
  // DATE too. rrule.js only ever writes the DATE-TIME form.
  const rrule = (line ? line.slice("RRULE:".length) : "").replace(/UNTIL=(\d{8})T000000Z/, "UNTIL=$1");

  return { dtstart, rrule, options, once: false, exdates, rdates, notes };
}

// ---------------------------------------------------------------------------
// occurrences, via rrule.js
// ---------------------------------------------------------------------------

/** The RRuleSet for a rule: the recurrence plus its RDATEs, minus its EXDATEs. */
export function ruleToSet(rule, { since = null } = {}) {
  const built = ruleToRRule(rule, { since });
  if (built.error) return built;
  const set = new RRuleSet();
  if (built.options) set.rrule(new RRule(built.options));
  else if (built.dtstart) set.rdate(keyToDate(built.dtstart));
  // RDATEs are ADDED to the set independently of COUNT and UNTIL: an explicit
  // date is the user saying "and also this one", not part of the pattern.
  for (const k of built.rdates) set.rdate(keyToDate(k));
  // EXDATE removes AFTER the rule has been sized, so an excluded date still
  // consumes one of a COUNT's N. That is RFC 5545 and it is what rrule.js does.
  for (const k of built.exdates) set.exdate(keyToDate(k));
  return { set, ...built };
}

// A rule that could not be BUILT and a rule that legitimately has no dates in
// the window are the same empty array, and for a calendar that difference is a
// deadline that silently never appears. So the real answers are Results and the
// bare-value functions below are thin unwrapOr wrappers over them - a caller
// that needs to tell the two apart can, and every default is greppable.
//
// `schema` is the kind: the rule does not match the shape the engine accepts.
// It is deliberately NOT retryable - asking again cannot fix a malformed rule,
// only editing it can, and ruleProblem() is the sentence that says how.
const SOURCE = { source: "recurrence rule" };

/** Every occurrence in [from, to] inclusive, as date keys. */
export function occurrencesResult(rule, from, to, cap = 24) {
  if (!parseKey(from) || !parseKey(to)) {
    return Err("schema", new Error(`occurrencesBetween needs YYYY-MM-DD bounds, got ${String(from)}..${String(to)}`), SOURCE);
  }
  const built = ruleToSet(rule || {}, { since: from });
  if (built.error) return Err("schema", new Error(built.error), SOURCE);
  return Ok(built.set.between(keyToDate(from), keyToDate(to), true).map(dateToKey).slice(0, cap), SOURCE);
}

/** The next occurrence on or after `from`. `from` is inclusive. */
export function nextOccurrenceResult(rule, from) {
  if (!parseKey(from)) {
    return Err("schema", new Error(`nextOccurrence needs a YYYY-MM-DD date, got ${String(from)}`), SOURCE);
  }
  const built = ruleToSet(rule || {}, { since: from });
  if (built.error) return Err("schema", new Error(built.error), SOURCE);
  const d = built.set.after(keyToDate(from), true);
  // No date is a real answer here, not a failure: a one-off that has passed, or
  // a series past its UNTIL, genuinely has no next occurrence.
  return Ok(d ? dateToKey(d) : null, SOURCE);
}

export function occurrencesBetween(rule, from, to, cap = 24) {
  return unwrapOr(occurrencesResult(rule, from, to, cap), []);
}

export function nextOccurrence(rule, from) {
  return unwrapOr(nextOccurrenceResult(rule, from), null);
}

// ---------------------------------------------------------------------------
// reading iCalendar text with rrule.js
// ---------------------------------------------------------------------------

// MEASURED LIMITATION of rrule.js 2.8.1: `rrulestr` ignores a DTSTART/EXDATE/
// RDATE line that carries parameters. Handed
//   DTSTART;VALUE=DATE:20260803 / RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR
// it silently substitutes `new Date()` for the start - the expansion then begins
// at the wall clock, and an EXDATE;VALUE=DATE never matches anything it is meant
// to remove. Date-valued properties are the whole dialect this app writes, so
// they are normalised to the UTC-midnight DATE-TIME form rrulestr does read,
// which is the same instant our keys already mean.
const RECURRENCE_PROPERTIES = ["DTSTART", "RRULE", "EXDATE", "RDATE"];

export function normaliseICalendar(text) {
  return String(text == null ? "" : text)
    // Unfold first (RFC 5545 3.1: CRLF + one space or tab continues a line), or a
    // folded RDATE list arrives as a property line plus several lines of junk.
    .replace(/\r\n[ \t]/g, "")
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      const colon = line.indexOf(":");
      if (colon === -1) return line;              // a bare "FREQ=…" is what most people paste
      const name = line.slice(0, colon).split(";")[0].toUpperCase();
      // Everything else in a VEVENT is dropped rather than passed through:
      // rrulestr is a rule parser, not a calendar parser, and handed a whole
      // BEGIN:VCALENDAR block it returns an empty set with no error at all.
      if (RECURRENCE_PROPERTIES.indexOf(name) === -1) return "";
      if (name === "RRULE") return `RRULE:${line.slice(colon + 1)}`;
      const values = line.slice(colon + 1).split(",").map((v) => {
        const m = /^(\d{8})(?:T\d{6}Z?)?$/.exec(v.trim());
        return m ? `${m[1]}T000000Z` : v.trim();
      });
      return `${name}:${values.join(",")}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Expand iCalendar text with rrule.js and return date keys in [from, to].
 *
 * This is the reference reading of a rule, used to CHECK our own - both the
 * codec's round trip and the conformance sweep lean on it.
 */
export function expandICalendar(text, from, to, cap = 400) {
  if (!parseKey(from) || !parseKey(to)) return { dates: [], error: "bad window" };
  let set;
  try {
    set = rrulestr(normaliseICalendar(text), { forceset: true });
  } catch (err) {
    return { dates: [], error: String((err && err.message) || err) };
  }
  try {
    return { dates: set.between(keyToDate(from), keyToDate(to), true).map(dateToKey).slice(0, cap) };
  } catch (err) {
    return { dates: [], error: String((err && err.message) || err) };
  }
}
