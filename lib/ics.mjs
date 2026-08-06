// iCALENDAR IN AND OUT - the universal calendar mirror.
//
// The ask, said out loud: "the calendar must be able to mirror ANY other
// calendar, not just Google." There is exactly one answer to that and it is
// RFC 5545. Every calendar on earth exports .ics and most publish a
// subscribable .ics URL, so an importer that reads a real Google/Apple/Outlook
// export is worth more than four provider APIs.
//
// PURE. No DOM, no Supabase, no clock, and - deliberately - NO import of
// vendor/ical.js. The parser is INJECTED (`{ parser: ICAL }`) or a pre-parsed
// component is handed in, so this module runs in plain Node under
// tests/ics.test.mjs and in the browser under src/ui/calendar-import.js with
// the same code path. It imports only our own pure libs.
//
// ---------------------------------------------------------------------------
// THE FOUR THINGS THAT MAKE THIS HARDER THAN IT LOOKS
//
// 1. TIMEZONES ARE NOT DECORATION. A VEVENT at 23:30 America/New_York is
//    09:00 the NEXT DAY in Asia/Kolkata. Importing it as "23:30 on the 10th"
//    keeps a number and loses a day. Worse, jarvis evaluates `timedDue` with
//    ONE profile timezone for every row (supabase/functions/jarvis/index.ts
//    calls `timedDue(all, todayKey, localMinutesNow(now, tz))`), so a reminder
//    row carrying `timezone: 'America/New_York'` would be compared against IST
//    minutes and fire 9.5 hours early, silently. So every imported time is
//    CONVERTED into the target zone, and when that conversion moves the day the
//    recurrence parts are moved with it or the event is refused by name.
//
// 2. ical.js DOES NOT SHIP A TIMEZONE DATABASE. `DTSTART;TZID=Asia/Calcutta`
//    with no VTIMEZONE (a real Apple export) parses to a FLOATING time, and
//    `convertToZone(UTC)` on a floating time returns the wall clock unchanged -
//    a silent 5.5 hour error that looks like data. Measured, not assumed: see
//    the probe in the report. So VTIMEZONEs found in the file are attached to
//    the values directly (no global TimezoneService mutation), and a bare TZID
//    is resolved through Intl instead, with a named problem when neither works.
//
// 3. OUTLOOK DOES NOT USE IANA ZONE NAMES. It writes
//    `DTSTART;TZID="India Standard Time":...` - a Windows zone id, quoted
//    because it contains spaces, and Microsoft's own docs acknowledge these are
//    not in the tz database. When the VTIMEZONE is present its offsets are
//    authoritative and the name does not matter; when it is absent WINDOWS_ZONES
//    below maps the common ones and anything else becomes a problem, never a
//    guess.
//
// 4. RECURRENCE-ID IS A SECOND VEVENT. "Move the 17th to the 18th" arrives as
//    an extra VEVENT with the same UID. Our rule model has no per-instance
//    override, but it does have EXDATE and RDATE, and
//    "exdate the 17th + rdate the 18th" is EXACTLY that override. Overrides
//    that only change text are reported rather than applied.
//
// NOTHING IS EVER DROPPED IN SILENCE. Every component this file does not turn
// into a rule lands in `problems[]` with a reason and a severity:
//   severity "error"   - nothing was imported for it
//   severity "warning" - something was imported, but lossily; the reason says what
// This codebase's signature bug is a value computed or discarded one layer away
// from where the user would see it, so the preview shows the whole array.

import {
  parseKey, toKey, addDays, daysBetween, dateList, minutesOfDay, formatTime,
  ruleProblem, weekdayList, occurrencesBetween, ruleInterval, ruleCount, ruleStart,
} from "./reminders.mjs";
import { parseRRule, toRRule, fallbackRDate, needsClampDialect } from "./rrule-codec.mjs";
import { saDayKey, saMinuteOfDay, zonedToUtcIso } from "./schedule-args.mjs";

export const DEFAULT_TZ = "Asia/Kolkata";
export const PRODID = "-//Trackerz//Calendar//EN";

const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// The reminders table columns an import may write. Anything not here is dropped
// by toInsertRow(), which is the ONLY transformation between the row shown in
// the preview and the row inserted - see the note on toInsertRow.
export const REMINDER_COLUMNS = Object.freeze([
  "title", "note", "kind", "freq", "day_of_month", "month_of_year", "weekday",
  "on_date", "lead_days", "active", "rule_interval", "dtstart", "nth_weekday",
  "weekdays", "until", "max_count", "exdates", "rdates", "at_time", "timezone",
]);

// The kinds `reminders.kind` actually permits (schema check constraint).
const KINDS = ["task", "birthday", "anniversary", "bill", "filing", "appointment", "other"];

// Windows zone id -> IANA, for the Outlook case where the VTIMEZONE is missing
// and the offsets therefore are not in the file at all. A SUBSET of CLDR on
// purpose: an id that is not here produces a named problem, and a named problem
// is strictly better than a zone guessed from a similar-looking string.
export const WINDOWS_ZONES = Object.freeze({
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Arabian Standard Time": "Asia/Dubai",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Canada Central Standard Time": "America/Regina",
  "Central America Standard Time": "America/Guatemala",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Central Standard Time": "America/Chicago",
  "China Standard Time": "Asia/Shanghai",
  "E. Africa Standard Time": "Africa/Nairobi",
  "E. Australia Standard Time": "Australia/Brisbane",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Eastern Standard Time": "America/New_York",
  "Egypt Standard Time": "Africa/Cairo",
  "GMT Standard Time": "Europe/London",
  "GTB Standard Time": "Europe/Bucharest",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "India Standard Time": "Asia/Kolkata",
  "Iran Standard Time": "Asia/Tehran",
  "Israel Standard Time": "Asia/Jerusalem",
  "Japan Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "Malay Peninsula Standard Time": "Asia/Singapore",
  "Mountain Standard Time": "America/Denver",
  "Myanmar Standard Time": "Asia/Yangon",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Nepal Standard Time": "Asia/Kathmandu",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Pacific SA Standard Time": "America/Santiago",
  "Pacific Standard Time": "America/Los_Angeles",
  "Romance Standard Time": "Europe/Paris",
  "Russian Standard Time": "Europe/Moscow",
  "SA Pacific Standard Time": "America/Bogota",
  "SA Western Standard Time": "America/La_Paz",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Singapore Standard Time": "Asia/Singapore",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Turkey Standard Time": "Europe/Istanbul",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "US Mountain Standard Time": "America/Phoenix",
  "UTC": "UTC",
  "W. Australia Standard Time": "Australia/Perth",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "W. Europe Standard Time": "Europe/Berlin",
  "West Asia Standard Time": "Asia/Tashkent",
});

// ---------------------------------------------------------------------------
// Timezone helpers. Intl is the tz database in both Node and the browser; it is
// the only reason this file can be dependency-free and still correct.
// ---------------------------------------------------------------------------

/** Does Intl know this zone id? The cheapest possible "is it IANA" test. */
export function isKnownZone(id) {
  const s = String(id == null ? "" : id).trim();
  if (!s) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: s });
    return true;
  } catch (err) {
    // A RangeError here is the ANSWER, not a failure: Intl throws for an id it
    // does not know. Nothing is being swallowed - false is the fact.
    if (err instanceof RangeError) return false;
    throw err;
  }
}

/**
 * A TZID from a file mapped onto something Intl understands.
 * Returns null when it cannot be mapped, so the caller can say so out loud.
 */
export function normalizeTzid(tzid) {
  const raw = String(tzid == null ? "" : tzid).trim().replace(/^"|"$/g, "");
  if (!raw) return null;
  if (isKnownZone(raw)) return raw;
  const win = WINDOWS_ZONES[raw];
  if (win && isKnownZone(win)) return win;
  // Google writes X-LIC-LOCATION for its own VTIMEZONEs; some exporters prefix
  // the id with a path-like junk segment ("/mozilla.org/20050126_1/Europe/Paris").
  const tail = raw.split("/").slice(-2).join("/");
  if (tail !== raw && isKnownZone(tail)) return tail;
  return null;
}

/** UTC offset of `tz` at `instant`, in minutes. */
function offsetMinutes(tz, instant) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(instant instanceof Date ? instant : new Date(instant))
    .find((p) => p.type === "timeZoneName");
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(label ? label.value : "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** "+0530" for a zone whose offset never changes, or null when it has DST. */
export function fixedOffsetOf(tz) {
  if (!isKnownZone(tz)) return null;
  let first = null;
  for (let month = 0; month < 12; month++) {
    const probe = Date.UTC(2026, month, 15, 12, 0, 0);
    const mins = offsetMinutes(tz, probe);
    if (first == null) first = mins;
    else if (mins !== first) return null;
  }
  const sign = first < 0 ? "-" : "+";
  const abs = Math.abs(first);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Reading a calendar
// ---------------------------------------------------------------------------

function problem(list, severity, reason, ctx = {}) {
  list.push({ severity, reason, uid: ctx.uid || null, summary: ctx.summary || null, component: ctx.component || "VEVENT" });
}

function textOf(component, name) {
  const v = component.getFirstPropertyValue(name);
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/**
 * One ICAL.Time -> a date key (and minutes) in the TARGET zone.
 *
 * Returns { key, minutes, allDay, sourceZone, shift, note } or { error }.
 * `shift` is how many days the conversion moved the calendar date: 0 almost
 * always, +1 or -1 for a late-evening or early-morning event seen from far
 * away. Nothing else in this file is allowed to assume it is 0.
 */
function resolveTime(prop, { ICAL, zones, targetTz }) {
  const time = prop.getFirstValue();
  if (!time || typeof time.toString !== "function") return { error: "value is not a date" };
  const wallKey = toKey(time.year, time.month, time.day);
  if (!parseKey(wallKey)) return { error: `unreadable date "${time.toString()}"` };
  if (time.isDate) return { key: wallKey, minutes: null, allDay: true, sourceZone: null, shift: 0, note: null };

  const wallMinutes = time.hour * 60 + time.minute;
  const param = prop.getParameter("tzid");
  const paramTz = param == null ? null : String(param).replace(/^"|"$/g, "");
  const attached = paramTz ? zones.get(paramTz) : null;
  let instantIso = null;
  let sourceZone = null;
  let note = null;

  if (attached) {
    // The file carried its own VTIMEZONE. Its offsets are authoritative even
    // when the id is a Windows name Intl has never heard of.
    time.zone = attached;
    instantIso = time.toJSDate().toISOString();
    sourceZone = normalizeTzid(paramTz) || paramTz;
  } else if (time.zone && time.zone.tzid === "UTC") {
    instantIso = time.toJSDate().toISOString();
    sourceZone = "UTC";
  } else if (paramTz) {
    const iana = normalizeTzid(paramTz);
    if (!iana) {
      return {
        error: `TZID "${paramTz}" has no VTIMEZONE in the file and is not a zone this build knows`,
      };
    }
    instantIso = zonedToUtcIso(wallKey, formatTime(wallMinutes), iana);
    sourceZone = iana;
    note = `TZID "${paramTz}" had no VTIMEZONE; resolved as ${iana}`;
  } else {
    // RFC 5545 floating time: "the local time of wherever you are". That is the
    // target zone, so there is nothing to convert and no day to lose.
    return { key: wallKey, minutes: wallMinutes, allDay: false, sourceZone: null, shift: 0, note: null };
  }

  const key = saDayKey(instantIso, targetTz);
  const minutes = saMinuteOfDay(instantIso, targetTz);
  const shift = daysBetween(wallKey, key);
  return { key, minutes, allDay: false, sourceZone, shift: shift == null ? 0 : shift, note, instantIso };
}

/** Shift a BYDAY token ("MO", "3TU", "-1FR") by whole days. */
function shiftByDay(token, shift) {
  const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(String(token).trim());
  if (!m) return { error: `BYDAY value "${token}" is not a weekday` };
  if (shift === 0) return { token: String(token).toUpperCase() };
  if (m[1]) {
    // "the 3rd Tuesday" moved one day is not "the 3rd Wednesday" in every
    // month, so this is refused rather than approximated.
    return { error: `BYDAY=${token} cannot be moved ${shift > 0 ? "forward" : "back"} a day when converting to the target timezone` };
  }
  const idx = ICAL_DAYS.indexOf(m[2].toUpperCase());
  return { token: ICAL_DAYS[(idx + shift + 7) % 7] };
}

/**
 * An ICAL.Recur rebuilt as an RRULE string in the TARGET zone.
 *
 * Rebuilt rather than passed through for two reasons: UNTIL is in UTC and can
 * name a different calendar day in the target zone, and a day-shifting
 * conversion has to move BYDAY/BYMONTHDAY with it. Unknown BY* parts are copied
 * verbatim so lib/rrule-codec.mjs can warn about them - dropping them here
 * would hide the fact that the rule fires on different dates than the file says.
 */
function recurToRRuleText(recur, { shift, targetTz }) {
  const parts = [];
  const freq = String(recur.freq || "").toUpperCase();
  if (!freq) return { error: "RRULE has no FREQ" };
  parts.push(`FREQ=${freq}`);
  const interval = Number(recur.interval);
  if (Number.isInteger(interval) && interval > 1) parts.push(`INTERVAL=${interval}`);

  const raw = recur.parts || {};
  for (const name of Object.keys(raw)) {
    const values = Array.isArray(raw[name]) ? raw[name] : [raw[name]];
    if (name === "BYDAY") {
      const out = [];
      for (const token of values) {
        const moved = shiftByDay(token, shift);
        if (moved.error) return { error: moved.error };
        out.push(moved.token);
      }
      parts.push(`BYDAY=${out.join(",")}`);
    } else if (name === "BYMONTHDAY") {
      const out = [];
      for (const value of values) {
        const n = Number(value) + shift;
        if (shift !== 0 && (!(n >= 1 && n <= 28))) {
          return { error: `BYMONTHDAY=${value} would cross a month boundary when converted to ${targetTz}` };
        }
        out.push(n);
      }
      parts.push(`BYMONTHDAY=${out.join(",")}`);
    } else {
      parts.push(`${name}=${values.join(",")}`);
    }
  }

  if (recur.count != null && Number(recur.count) >= 1) parts.push(`COUNT=${Number(recur.count)}`);
  if (recur.until) {
    const untilKey = recur.until.zone && recur.until.zone.tzid === "UTC"
      ? saDayKey(recur.until.toJSDate().toISOString(), targetTz)
      : toKey(recur.until.year, recur.until.month, recur.until.day);
    if (!parseKey(untilKey)) return { error: `UNTIL "${recur.until.toString()}" is not a date` };
    parts.push(`UNTIL=${untilKey.replace(/-/g, "")}`);
  }
  return { text: parts.join(";") };
}

// "Ravi's Birthday" imported as kind 'task' loses the cake and the lead time.
// CATEGORIES first (that is what remindersToIcs writes, so a round trip is
// exact), then the only two words worth guessing from.
function kindOf(component, freq) {
  const cats = String(textOf(component, "categories") || "").toLowerCase();
  for (const k of KINDS) if (cats.split(/\s*,\s*/).indexOf(k) !== -1) return k;
  const summary = String(textOf(component, "summary") || "").toLowerCase();
  if (freq === "yearly" && /\bbirthday\b|\bb'day\b|\bbday\b/.test(summary)) return "birthday";
  if (freq === "yearly" && /\banniversar/.test(summary)) return "anniversary";
  return "appointment";
}

function daySpanOf(component, startKey, allDay, ctx) {
  const endProp = component.getFirstProperty("dtend");
  if (!endProp) return 1;
  const end = resolveTime(endProp, ctx);
  if (end.error || !end.key) return 1;
  const gap = daysBetween(startKey, end.key);
  if (gap == null || gap < 0) return 1;
  // DTEND is EXCLUSIVE for DATE values (RFC 5545 3.8.2.2), inclusive in wall
  // terms for DATE-TIME. Getting this backwards makes every all-day event look
  // like it runs one day longer than it does.
  return allDay ? Math.max(1, gap) : gap + 1;
}

/**
 * Read an .ics file into reminder rule rows.
 *
 * @param {string|object} input   the file text, or an already-parsed ICAL.Component
 * @param {object} opts
 *   parser    the ICAL namespace (required when `input` is text)
 *   timezone  the zone every imported time is CONVERTED INTO (default Asia/Kolkata)
 *   leadDays  default lead_days for imported rows
 * @returns {{ reminders: object[], problems: object[], stats: object, calendar: object }}
 */
export function icsToReminders(input, { parser = null, timezone = DEFAULT_TZ, leadDays = 0 } = {}) {
  const problems = [];
  const targetTz = isKnownZone(timezone) ? timezone : DEFAULT_TZ;
  if (targetTz !== timezone) {
    problem(problems, "warning", `target timezone "${timezone}" is unknown here; used ${DEFAULT_TZ}`, { component: "VCALENDAR" });
  }

  let root = null;
  if (input && typeof input === "object" && typeof input.getAllSubcomponents === "function") {
    root = input;
  } else {
    const text = String(input == null ? "" : input);
    if (!parser || typeof parser.parse !== "function" || typeof parser.Component !== "function") {
      throw new Error("icsToReminders needs an injected iCalendar parser: pass { parser: ICAL }");
    }
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      problem(problems, "error", "this file has no BEGIN:VCALENDAR line, so it is not an iCalendar file", { component: "FILE" });
      return { reminders: [], problems, stats: emptyStats(), calendar: {} };
    }
    try {
      root = new parser.Component(parser.parse(text));
    } catch (err) {
      problem(problems, "error", `the file could not be parsed: ${err && err.message ? err.message : String(err)}`, { component: "FILE" });
      return { reminders: [], problems, stats: emptyStats(), calendar: {} };
    }
  }

  const ICAL = parser;
  const calendar = {
    name: textOf(root, "x-wr-calname") || textOf(root, "name") || "",
    prodid: textOf(root, "prodid") || "",
    sourceTimezone: textOf(root, "x-wr-timezone") || "",
    method: textOf(root, "method") || "",
  };

  // VTIMEZONEs are attached to values directly rather than registered in
  // ICAL.TimezoneService: the service is global, and two subscriptions that
  // disagree about "Customized Time Zone" would silently overwrite each other.
  const zones = new Map();
  if (ICAL && typeof ICAL.Timezone === "function") {
    for (const vtz of root.getAllSubcomponents("vtimezone")) {
      try {
        const tz = new ICAL.Timezone(vtz);
        if (tz && tz.tzid) zones.set(tz.tzid, tz);
      } catch (err) {
        problem(problems, "warning", `a VTIMEZONE could not be read (${err && err.message ? err.message : String(err)}); its events fall back to the TZID name`, { component: "VTIMEZONE" });
      }
    }
  }
  const ctx = { ICAL, zones, targetTz };

  // Everything that is not a VEVENT gets NAMED, never dropped quietly.
  const counts = { vevent: 0, override: 0, imported: 0, refused: 0 };
  for (const sub of root.getAllSubcomponents()) {
    const name = String(sub.name || "").toLowerCase();
    if (name === "vevent" || name === "vtimezone") continue;
    problem(problems, "warning", `${name.toUpperCase()} components are not imported (only VEVENT is)`, { component: name.toUpperCase() });
  }

  // Group by UID so RECURRENCE-ID overrides can find their master. An event
  // with NO UID still gets a bucket of its own (a synthetic key), because the
  // first draft of this loop pushed a null for it and lost the event entirely -
  // the exact class of bug this file is written against.
  const events = root.getAllSubcomponents("vevent");
  const byUid = new Map();
  for (let i = 0; i < events.length; i++) {
    const ve = events[i];
    counts.vevent += 1;
    const uid = textOf(ve, "uid");
    const isOverride = Boolean(ve.getFirstProperty("recurrence-id"));
    if (isOverride) counts.override += 1;
    if (!uid) {
      problem(problems, "warning", "this event has no UID, so it cannot be matched to a series or to an earlier import", { summary: textOf(ve, "summary") });
    }
    // No UID, or a second master under one UID: both get their own bucket
    // rather than overwriting an event that is already there.
    let key = uid || `__nouid__${i}`;
    let bucket = byUid.get(key);
    if (bucket && !isOverride && bucket.master) key = `${key}__dup__${i}`;
    bucket = byUid.get(key);
    if (!bucket) { bucket = { uid: uid || null, master: null, overrides: [] }; byUid.set(key, bucket); }
    if (isOverride) bucket.overrides.push(ve);
    else bucket.master = ve;
  }

  const reminders = [];
  for (const bucket of byUid.values()) {
    const uid = bucket.uid;
    if (!bucket.master) {
      // An override whose master event is not in the file. It is still a real
      // appointment, so it is imported as a one-off rather than thrown away.
      for (const ve of bucket.overrides) {
        problem(problems, "warning", "this is a change to one instance of a series whose master event is not in the file; imported as a single date", { uid, summary: textOf(ve, "summary") });
        const row = buildRow(ve, { ctx, problems, leadDays, targetTz, uid, forceOnce: true });
        if (row) { reminders.push(row); counts.imported += 1; } else counts.refused += 1;
      }
      continue;
    }
    const row = buildRow(bucket.master, { ctx, problems, leadDays, targetTz, uid, overrides: bucket.overrides });
    if (row) { reminders.push(row); counts.imported += 1; } else counts.refused += 1;
  }

  const stats = {
    vevents: counts.vevent,
    overrides: counts.override,
    imported: counts.imported,
    refused: counts.refused,
    errors: problems.filter((p) => p.severity === "error").length,
    warnings: problems.filter((p) => p.severity === "warning").length,
    timezone: targetTz,
  };
  return { reminders, problems, stats, calendar };
}

function emptyStats() {
  return { vevents: 0, overrides: 0, imported: 0, refused: 0, errors: 0, warnings: 0, timezone: DEFAULT_TZ };
}

/**
 * One VEVENT (plus its overrides) -> one reminder row, or null with a problem.
 *
 * The returned object IS the row that gets inserted, apart from the `_source`
 * block that toInsertRow() strips. Everything the preview shows is read off
 * this same object.
 */
function buildRow(ve, { ctx, problems, leadDays, targetTz, uid, overrides = [], forceOnce = false }) {
  const summary = textOf(ve, "summary") || "(untitled event)";
  const where = { uid, summary };

  const status = String(textOf(ve, "status") || "").toUpperCase();
  if (status === "CANCELLED") {
    problem(problems, "warning", "this event is marked STATUS:CANCELLED in the file and was not imported", where);
    return null;
  }

  const startProp = ve.getFirstProperty("dtstart");
  if (!startProp) {
    problem(problems, "error", "the event has no DTSTART, so there is no date to remind you on", where);
    return null;
  }
  const start = resolveTime(startProp, ctx);
  if (start.error) {
    problem(problems, "error", `DTSTART could not be read: ${start.error}`, where);
    return null;
  }
  if (start.note) problem(problems, "warning", start.note, where);

  // Outlook's older all-day form: a midnight-to-midnight timed event flagged
  // with a Microsoft property rather than VALUE=DATE. Read as timed it becomes
  // "reminds you at 00:00", which is a different thing from "all day".
  const cdoAllDay = String(textOf(ve, "x-microsoft-cdo-alldayevent") || "").toUpperCase() === "TRUE";
  const allDay = start.allDay || (cdoAllDay && start.minutes === 0);
  if (cdoAllDay && !start.allDay && start.minutes !== 0) {
    problem(problems, "warning", "X-MICROSOFT-CDO-ALLDAYEVENT is TRUE but DTSTART carries a time; the time was kept", where);
  }

  const shift = allDay ? 0 : start.shift;
  const rrule = ve.getFirstPropertyValue("rrule");

  let ruleText = `DTSTART;VALUE=DATE:${start.key.replace(/-/g, "")}`;
  if (rrule && !forceOnce) {
    const built = recurToRRuleText(rrule, { shift, targetTz });
    if (built.error) {
      problem(problems, "error", `the repeat rule could not be converted to ${targetTz}: ${built.error}`, where);
      return null;
    }
    ruleText += `\r\nRRULE:${built.text}`;
  } else if (rrule && forceOnce) {
    problem(problems, "warning", "the RRULE on this instance override was ignored; only its date was kept", where);
  }

  // EXDATE / RDATE. Every value is converted on its own, so a series whose
  // exceptions sit on the far side of a date line still excludes the right days.
  const exdates = [];
  const rdates = [];
  for (const [name, sink] of [["exdate", exdates], ["rdate", rdates]]) {
    for (const prop of ve.getAllProperties(name)) {
      const values = prop.getValues();
      for (let i = 0; i < values.length; i++) {
        const single = { getFirstValue: () => values[i], getParameter: (p) => prop.getParameter(p) };
        const resolved = resolveTime(single, ctx);
        if (resolved.error) {
          problem(problems, "warning", `an ${name.toUpperCase()} value was skipped: ${resolved.error}`, where);
          continue;
        }
        if (name === "rdate" && prop.getParameter("value") === "PERIOD") {
          problem(problems, "warning", "an RDATE with a PERIOD value was reduced to its start date", where);
        }
        sink.push(resolved.key);
      }
    }
  }

  // RECURRENCE-ID overrides, expressed the only way our rule model can hold
  // them: drop the original date, add the new one.
  for (const ov of overrides) {
    const ridProp = ov.getFirstProperty("recurrence-id");
    if (!ridProp) continue;
    const rid = resolveTime(ridProp, ctx);
    if (rid.error) {
      problem(problems, "warning", `an instance override was skipped: RECURRENCE-ID ${rid.error}`, where);
      continue;
    }
    const ovStatus = String(textOf(ov, "status") || "").toUpperCase();
    if (ovStatus === "CANCELLED") {
      exdates.push(rid.key);
      problem(problems, "warning", `the instance on ${rid.key} is cancelled in the file and was excluded`, where);
      continue;
    }
    const ovStartProp = ov.getFirstProperty("dtstart");
    const ovStart = ovStartProp ? resolveTime(ovStartProp, ctx) : { error: "no DTSTART" };
    if (ovStart.error) {
      problem(problems, "warning", `an instance override on ${rid.key} was skipped: ${ovStart.error}`, where);
      continue;
    }
    if (ovStart.key !== rid.key) {
      exdates.push(rid.key);
      rdates.push(ovStart.key);
      problem(problems, "warning", `the instance on ${rid.key} was moved to ${ovStart.key} in the file; kept as an exception plus an extra date`, where);
    } else {
      const changed = [];
      const ovSummary = textOf(ov, "summary");
      if (ovSummary && ovSummary !== summary) changed.push("title");
      if (!allDay && ovStart.minutes !== start.minutes) changed.push("time");
      if (changed.length) {
        problem(problems, "warning", `the instance on ${rid.key} has a different ${changed.join(" and ")} in the file; one rule cannot hold a per-instance change, so the series value is used`, where);
      }
    }
  }

  if (exdates.length) ruleText += `\r\nEXDATE;VALUE=DATE:${dateList(exdates).map((k) => k.replace(/-/g, "")).join(",")}`;
  if (rdates.length) ruleText += `\r\nRDATE;VALUE=DATE:${dateList(rdates).map((k) => k.replace(/-/g, "")).join(",")}`;

  const parsed = parseRRule(ruleText);
  for (const note of parsed.lossy) problem(problems, "warning", note, where);
  if (!parsed.rule) {
    problem(problems, "error", "the repeat rule is not one this calendar can express, so nothing was imported for it", where);
    return null;
  }

  const rule = parsed.rule;
  // A shifted monthly/yearly rule whose day was derived from DTSTART rather
  // than BYMONTHDAY: the shift may have walked it across a month boundary,
  // which changes the rule rather than moving it.
  if (shift !== 0 && ["monthly", "quarterly", "yearly"].indexOf(rule.freq) !== -1) {
    const startDay = parseKey(start.key).d;
    if (!(startDay >= 1 && startDay <= 28)) {
      problem(problems, "error", `converting this monthly rule to ${targetTz} moves it to day ${startDay}, which does not exist in every month`, where);
      return null;
    }
  }
  if (shift !== 0) {
    problem(problems, "warning", `this event is ${start.sourceZone ? `${start.sourceZone} ` : ""}time; in ${targetTz} it falls ${shift > 0 ? "a day later" : "a day earlier"}, and its dates were moved with it`, where);
  }

  const freq = String(rule.freq || "");
  const spanDays = daySpanOf(ve, start.key, allDay, ctx);
  const description = textOf(ve, "description");
  const location = textOf(ve, "location");
  const noteParts = [];
  if (description) noteParts.push(description);
  if (location) noteParts.push(`Where: ${location}`);
  if (spanDays > 1) {
    const lastKey = addDays(start.key, spanDays - 1);
    noteParts.push(`Runs ${spanDays} days, ${start.key} to ${lastKey}`);
    problem(problems, "warning", `this event runs ${spanDays} days (${start.key} to ${lastKey}); a reminder is a single day, so it was set on the first`, where);
  }

  const leadProp = textOf(ve, "x-trackerz-lead-days");
  const leadFromFile = /^\d+$/.test(leadProp) ? Number(leadProp) : null;
  // Our own export marks a paused reminder with this rather than
  // STATUS:CANCELLED, which tells every OTHER calendar to delete the event.
  const activeProp = String(textOf(ve, "x-trackerz-active") || "").toUpperCase();
  const askedLead = Number(leadDays);
  const leadDefault = Number.isFinite(askedLead) && askedLead >= 0 ? Math.trunc(askedLead) : 0;

  const row = {
    title: String(summary).slice(0, 200),
    note: noteParts.length ? noteParts.join("\n").slice(0, 500) : null,
    kind: kindOf(ve, freq),
    freq,
    day_of_month: rule.day_of_month == null ? null : rule.day_of_month,
    month_of_year: rule.month_of_year == null ? null : rule.month_of_year,
    weekday: rule.weekday == null ? null : rule.weekday,
    on_date: rule.on_date || null,
    lead_days: leadFromFile == null ? leadDefault : leadFromFile,
    active: activeProp !== "FALSE",
    rule_interval: ruleInterval(rule),
    dtstart: rule.dtstart || start.key,
    nth_weekday: rule.nth_weekday == null ? null : rule.nth_weekday,
    weekdays: Array.isArray(rule.weekdays) && rule.weekdays.length ? rule.weekdays : null,
    until: rule.until || null,
    max_count: ruleCount(rule),
    exdates: exdates.length ? dateList(exdates) : null,
    rdates: rdates.length ? dateList(rdates) : null,
    at_time: allDay || start.minutes == null ? null : formatTime(start.minutes),
    timezone: targetTz,
    _source: {
      uid: uid || null,
      sourceZone: start.sourceZone,
      shiftDays: shift,
      allDay,
      spanDays,
      sequence: textOf(ve, "sequence"),
      lastModified: textOf(ve, "last-modified") || textOf(ve, "dtstamp"),
    },
  };

  // The last gate: a row the engine cannot fire is worse than no row, because
  // it looks like a reminder and never rings.
  const unusable = ruleProblem(row);
  if (unusable) {
    problem(problems, "error", `the imported rule would never fire: ${unusable}`, where);
    return null;
  }
  return row;
}

/**
 * The row minus its provenance block.
 *
 * This is the ONLY difference between the object the preview renders and the
 * object that is inserted. It cannot change a rule field: `_source` is the one
 * key removed and tests/ics.test.mjs asserts every REMINDER_COLUMNS value
 * survives it byte-for-byte.
 */
export function toInsertRow(item) {
  const out = {};
  for (const col of REMINDER_COLUMNS) {
    if (item && Object.prototype.hasOwnProperty.call(item, col)) out[col] = item[col];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing a calendar
// ---------------------------------------------------------------------------

function icsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 3.1: lines are folded at 75 OCTETS. Folding by characters splits a
// multi-byte character across the fold and produces mojibake in the importing
// calendar, so this counts UTF-8 bytes and never splits a code point.
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let current = "";
  let width = 0;
  for (const ch of Array.from(line)) {
    const size = enc.encode(ch).length;
    if (width + size > 75) {
      out.push(current);
      current = "";
      width = 1; // the leading space of a continuation line counts against 75
    }
    current += ch;
    width += size;
  }
  if (current) out.push(current);
  return out.join("\r\n ");
}

function vtimezoneLines(tz) {
  const offset = fixedOffsetOf(tz);
  if (!offset) return null;
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${tz}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${tz}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

function stampOf(now) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function compact(key) {
  return String(key).replace(/-/g, "");
}

function uidFor(row, index) {
  const source = row && row._source && row._source.uid;
  if (source) return String(source);
  if (row && row.id) return `${row.id}@trackerz`;
  const slug = String(row && row.title ? row.title : "reminder").replace(/[^a-z0-9]+/gi, "").slice(0, 24).toLowerCase();
  return `trackerz-${index}-${slug || "x"}@trackerz`;
}

/**
 * Reminder rule rows -> one .ics file.
 *
 * @returns {{ ics, problems, exported, skipped, dialects }}
 *
 * Rows that cannot be expressed are REPORTED, not skipped in silence: an export
 * that quietly loses the GST filing is the same failure as an import that
 * quietly invents one.
 *
 * The RRULE itself comes from lib/rrule-codec.mjs `toRRule`, not from a second
 * serialiser written here.
 *
 * ---------------------------------------------------------------------------
 * WHICH DIALECT THIS EMITS, AND WHY IT IS NOT ALWAYS RRULE
 *
 * `toRRule` expresses our clamped "the 31st" as
 * `BYMONTHDAY=28,29,30,31;BYSETPOS=-1`, which is a correct reading of RFC 5545
 * and reproduces the clamp exactly. ical.js 2.2.1 PARSES that faithfully -
 * `Recur.fromString(...).toString()` returns it unchanged - and then IGNORES
 * the BYSETPOS when expanding it, because `next_month()` only reaches the
 * set-position code inside its BYDAY branch (ical.js issue #960, open since
 * 2026-02-08; PR #985 unmerged). Measured against the copy vendored here:
 *
 *     FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1  from 2026-01-31
 *       ical.js 2.2.1  -> 38 dates in 2026
 *       our expander   -> 12 dates in 2026   (the intent)
 *
 * ical.js is the calendar engine inside Thunderbird, so "technically right" here
 * means a GST reminder that fires 38 times a year in the user's real calendar.
 * The same rule written as an explicit RDATE list is read correctly by every
 * parser tested. So `dialect: "auto"` (the default) emits an RRULE for
 * everything EXCEPT a rule that would need BYSETPOS, which is written as a
 * finite date list with a warning saying so and when to re-export.
 *
 * `dialect: "rrule"` forces the compact form (and warns when it emits BYSETPOS);
 * `dialect: "rdate"` forces the explicit list for everything. The IMPORT side
 * reads all of these, so flipping this changes nothing about what comes back.
 */
export function remindersToIcs(rows, {
  prodid = PRODID, calName = "Trackerz", now = new Date(), since = null,
  dialect = "auto", rdateYears = 3, rdateCap = 400,
} = {}) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  const problems = [];
  const bodies = [];
  const zonesUsed = new Set();
  const dialects = { rrule: 0, rdate: 0 };
  let skipped = 0;

  for (let i = 0; i < list.length; i++) {
    const row = list[i] || {};
    const where = { uid: uidFor(row, i), summary: row.title || "(untitled)" };
    const anchor = ruleStart(row) || since;
    // `toRRule` reads `rule.count`, but the DB column is `max_count` (Postgres
    // owns `count`, see the note in lib/reminders.mjs). Handing a row straight
    // from PostgREST to toRRule therefore drops the COUNT and exports a series
    // that never ends. Aliasing here rather than in rrule-codec because that
    // file has its own owner; ruleCount() is the shared reader either way.
    const exportable = { ...row, count: ruleCount(row), interval: ruleInterval(row) };
    let body = toRRule(exportable, { since: anchor });
    if (body.error) {
      problem(problems, "error", `"${row.title || "(untitled)"}" could not be exported: ${body.error}`, where);
      skipped += 1;
      continue;
    }

    // The dialect decision. `needsClampDialect` is lib/rrule-codec.mjs's own
    // predicate, called rather than re-derived here so there is ONE definition
    // of "the shape ical.js mis-expands"; the cheap string test in front of it
    // only avoids building the rule a second time for the 99% of rows that
    // could not possibly qualify.
    const needsSetPos = /BYSETPOS/.test(body.rrule || "") && needsClampDialect(exportable);
    let usedDialect = "rrule";
    if (dialect === "rdate" || (dialect === "auto" && needsSetPos)) {
      const listed = fallbackRDate(exportable, { from: anchor, years: rdateYears, cap: rdateCap });
      if (listed.error) {
        problem(problems, "warning", `"${row.title}" could not be written as an explicit date list (${listed.error}), so the compact rule was used instead`, where);
      } else {
        body = { dtstart: listed.dtstart, rrule: "", exdate: [], rdate: listed.rdate, notes: listed.notes || [] };
        usedDialect = "rdate";
        const last = listed.rdate[listed.rdate.length - 1];
        if (needsSetPos) {
          problem(problems, "warning", `"${row.title}" fires on a clamped day of the month. It is written as an explicit list of ${listed.rdate.length} dates ending ${last} rather than as a repeat rule, because the BYMONTHDAY=...;BYSETPOS=-1 form that expresses the clamp is parsed but NOT applied by ical.js 2.2.1 - the engine inside Thunderbird - which turns 12 fires a year into 38. Export again before ${last} to extend it.`, where);
        } else {
          problem(problems, "warning", `"${row.title}" is written as an explicit list of ${listed.rdate.length} dates ending ${last}; export again before then to extend it`, where);
        }
      }
    } else if (needsSetPos) {
      problem(problems, "warning", `"${row.title}" is exported as BYMONTHDAY=...;BYSETPOS=-1, which ical.js 2.2.1 (Thunderbird) parses but does not apply - it will fire on every day in the set instead of the last one`, where);
    }
    dialects[usedDialect] += 1;

    for (const note of body.notes || []) problem(problems, "warning", `"${row.title || "(untitled)"}": ${note}`, where);

    // Modifiers iCalendar cannot carry alongside what was written above. Both
    // of these change which dates fire, so an export that drops them without
    // saying so hands the user a calendar that quietly disagrees with the app.
    const hasCount = ruleCount(row) != null;
    const hasUntil = Boolean(parseKey(row.until));
    if (String(row.freq || "").toLowerCase() === "once" && (hasCount || hasUntil)) {
      problem(problems, "warning", `"${row.title}" is a one-off carrying a ${hasCount ? "count" : "cut-off date"}; a single VEVENT has nowhere to put that, so it was left out of the file`, where);
    } else if (hasCount && hasUntil) {
      problem(problems, "warning", `"${row.title}" has both a count and an until date; RFC 5545 allows only one per RRULE, so COUNT was written and UNTIL ${row.until} was left out`, where);
    }

    const minutes = minutesOfDay(row.at_time);
    const tz = minutes == null ? null : (isKnownZone(row.timezone) ? row.timezone : DEFAULT_TZ);
    if (minutes != null && tz !== row.timezone && row.timezone) {
      problem(problems, "warning", `"${row.title}" has timezone "${row.timezone}", which is not a zone this build knows; exported as ${DEFAULT_TZ}`, where);
    }
    let dateSuffix = "";
    let param = ";VALUE=DATE";
    if (minutes != null) {
      zonesUsed.add(tz);
      dateSuffix = `T${formatTime(minutes).replace(":", "")}00`;
      param = `;TZID=${tz}`;
      if (!fixedOffsetOf(tz)) {
        problem(problems, "warning", `"${row.title}" is in ${tz}, which observes daylight saving; the file names the zone but cannot carry its rules, so the importing calendar must know ${tz} itself`, where);
      }
    }

    const lines = [
      "BEGIN:VEVENT",
      `UID:${uidFor(row, i)}`,
      `DTSTAMP:${stampOf(now)}`,
      `DTSTART${param}:${compact(body.dtstart)}${dateSuffix}`,
    ];
    if (body.rrule) lines.push(`RRULE:${body.rrule}`);
    if (body.exdate && body.exdate.length) {
      lines.push(`EXDATE${param}:${body.exdate.map((k) => `${compact(k)}${dateSuffix}`).join(",")}`);
    }
    if (body.rdate && body.rdate.length) {
      lines.push(`RDATE${param}:${body.rdate.map((k) => `${compact(k)}${dateSuffix}`).join(",")}`);
    }
    lines.push(`SUMMARY:${icsEscape(row.title || "Reminder")}`);
    if (row.note) lines.push(`DESCRIPTION:${icsEscape(row.note)}`);
    if (row.kind) lines.push(`CATEGORIES:${icsEscape(row.kind)}`);
    const lead = Number(row.lead_days);
    if (Number.isInteger(lead) && lead > 0) lines.push(`X-TRACKERZ-LEAD-DAYS:${lead}`);
    if (minutes == null) lines.push("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE");
    // NOT STATUS:CANCELLED. A paused reminder is ours to pause; publishing a
    // cancellation tells every calendar subscribed to this file to DELETE the
    // event, which is a destructive act triggered by a toggle in our Settings.
    if (row.active === false) lines.push("X-TRACKERZ-ACTIVE:FALSE");
    lines.push("END:VEVENT");
    bodies.push(lines);
  }

  const head = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodid}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calName)}`,
    `X-WR-TIMEZONE:${[...zonesUsed][0] || DEFAULT_TZ}`,
  ];
  for (const tz of [...zonesUsed].sort()) {
    const block = vtimezoneLines(tz);
    if (block) head.push(...block);
  }

  const all = [...head, ...bodies.flat(), "END:VCALENDAR"];
  return {
    ics: `${all.map(foldLine).join("\r\n")}\r\n`,
    problems,
    exported: bodies.length,
    skipped,
    dialects,
  };
}

// ---------------------------------------------------------------------------
// Identity, for round-tripping and for subscription refresh
// ---------------------------------------------------------------------------

/**
 * `month_of_year` reduced to the phase it actually names.
 *
 * lib/reminders.mjs walks months in steps of `step` from `month_of_year`, so
 * every month congruent to it modulo `step` names the SAME series: a quarterly
 * rule anchored on October and one anchored on January both fire in
 * Jan/Apr/Jul/Oct. That matters here because exporting a quarterly rule writes
 * `BYMONTH=1,4,7,10` and reading it back takes the lowest of them, so the
 * anchor comes home as January. The dates are identical; only the label moved.
 */
function canonicalPhaseMonth(rule) {
  const freq = String(rule.freq || "").toLowerCase();
  const month = Number(rule.month_of_year);
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";
  if (freq === "once" || freq === "daily" || freq === "weekly") return "";
  const n = ruleInterval(rule);
  const step = freq === "monthly" ? n : (freq === "quarterly" ? 3 : 12) * n;
  if (step < 1 || step > 12) return String(month);
  return String(((month - 1) % step) + 1);
}

/**
 * The weekdays a rule ACTUALLY consults, as the engine would read them.
 *
 * Not `weekdayList()` directly, for a measured reason: that helper turns an
 * explicit `weekday: null` (which is what PostgREST hands back for an empty
 * column, and what an imported one-off carries) into `[0]`, because
 * `Number(null)` is 0 and 0 is a valid Sunday. An ABSENT weekday correctly
 * yields `[]`. So a stored NULL and a missing key disagree, and a fingerprint
 * built on that would call a one-off "Sundays". Nulls are dropped here first,
 * and freqs that never look at a weekday return nothing at all.
 */
function weekdaysOf(rule) {
  const freq = String(rule.freq || "").toLowerCase();
  const nth = Number(rule.nth_weekday);
  const hasNth = Number.isInteger(nth) && nth !== 0;
  if (freq !== "weekly" && !hasNth) return [];
  const raw = Array.isArray(rule.weekdays)
    ? rule.weekdays
    : [rule.weekdays != null ? rule.weekdays : rule.weekday];
  const list = weekdayList({ weekdays: raw.filter((v) => v != null) });
  return hasNth && freq !== "weekly" ? list.slice(0, 1) : list;
}

/**
 * A stable string for the SEMANTICS of a rule - what it means, not how it was
 * stored. Two rows with the same fingerprint fire on the same days at the same
 * time; the round-trip test compares these rather than object shapes, because
 * `weekday: 1` and `weekdays: [1]` are the same rule and only one of them
 * survives an export.
 */
export function ruleFingerprint(rule) {
  const r = rule || {};
  const freq = String(r.freq || "").toLowerCase();
  const parts = [
    `freq=${freq}`,
    `interval=${ruleInterval(r)}`,
    `dom=${r.day_of_month == null ? "" : r.day_of_month}`,
    `moy=${canonicalPhaseMonth(r)}`,
    `wd=${weekdaysOf(r).join("|")}`,
    `nth=${Number.isInteger(Number(r.nth_weekday)) && Number(r.nth_weekday) !== 0 ? Number(r.nth_weekday) : ""}`,
    `on=${r.on_date || ""}`,
    `start=${ruleStart(r) || ""}`,
    `until=${parseKey(r.until) ? r.until : ""}`,
    `count=${ruleCount(r) == null ? "" : ruleCount(r)}`,
    `ex=${dateList(r.exdates).join("|")}`,
    `rd=${dateList(r.rdates).join("|")}`,
    `at=${minutesOfDay(r.at_time) == null ? "" : formatTime(minutesOfDay(r.at_time))}`,
  ];
  return parts.join(";");
}

/**
 * The dates a rule actually fires on, over a window. The strongest round-trip
 * assertion available: two rules that produce the same dates ARE the same rule,
 * whatever their parts look like.
 */
export function occurrenceSet(rule, from, years = 3, cap = 200) {
  const p = parseKey(from);
  if (!p) return [];
  const to = toKey(p.y + years, p.m, p.d);
  return occurrencesBetween(rule, from, to, cap);
}

// ---------------------------------------------------------------------------
// Subscribable URLs
// ---------------------------------------------------------------------------

/**
 * webcal:// -> https://, and a hard no to anything else.
 *
 * `webcal` is not a real protocol - it is http(s) with a different scheme so
 * the OS opens a calendar app. Every publisher that offers one also serves the
 * same file over https.
 */
export function icsUrlToHttps(url) {
  const raw = String(url == null ? "" : url).trim();
  if (!raw) return { error: "no URL" };
  const lower = raw.toLowerCase();
  if (lower.startsWith("webcal://")) return { url: `https://${raw.slice("webcal://".length)}` };
  if (lower.startsWith("webcals://")) return { url: `https://${raw.slice("webcals://".length)}` };
  if (lower.startsWith("https://")) return { url: raw };
  if (lower.startsWith("http://")) {
    return { url: `https://${raw.slice("http://".length)}`, note: "http was upgraded to https" };
  }
  return { error: `"${raw.slice(0, 60)}" is not a calendar URL - it should start with https:// or webcal://` };
}

/**
 * The request the EDGE FUNCTION has to make on the browser's behalf.
 *
 * A browser cannot fetch a foreign .ics: almost none of them send
 * Access-Control-Allow-Origin, so the fetch fails at the network layer with no
 * readable reason. This builds the body for the one endpoint still needed
 * (documented in the report): POST supabase/functions/gcal
 *   { action: "fetch_ics", url, etag?, lastModified? }
 * -> { ok, status, text, etag, lastModified }  |  { ok: false, error }
 */
export function icsProxyRequest(url, { etag = null, lastModified = null } = {}) {
  const resolved = icsUrlToHttps(url);
  if (resolved.error) return { error: resolved.error };
  return {
    endpoint: "gcal",
    body: {
      action: "fetch_ics",
      url: resolved.url,
      etag: etag || null,
      last_modified: lastModified || null,
    },
    note: resolved.note || null,
  };
}

/**
 * What a refresh from a subscription would CHANGE, before anything is written.
 *
 * Identity is the source UID when the feed gives one, and the rule fingerprint
 * otherwise (a feed that regenerates its UIDs every publish would otherwise
 * delete and recreate the whole calendar every hour).
 *
 * `gone` is what the feed no longer contains. It is returned as a DEACTIVATE
 * list, never a delete list: a truncated download and a genuinely emptied
 * calendar look identical from here, and the gcal migration's own rule is that
 * a removal must be an explicit tombstone rather than an absence.
 */
export function subscriptionPlan({ incoming = [], existing = [], sourceUrl = null } = {}) {
  const keyOf = (row) => {
    const uid = row && row._source && row._source.uid;
    if (uid) return `uid:${uid}`;
    if (row && row.source_uid) return `uid:${row.source_uid}`;
    return `rule:${String(row && row.title ? row.title : "").trim().toLowerCase()}:${ruleFingerprint(row)}`;
  };
  const existingByKey = new Map();
  for (const row of existing) existingByKey.set(keyOf(row), row);

  const create = [];
  const update = [];
  const unchanged = [];
  const seen = new Set();
  for (const row of incoming) {
    const key = keyOf(row);
    seen.add(key);
    const prior = existingByKey.get(key);
    if (!prior) { create.push(row); continue; }
    const same = ruleFingerprint(prior) === ruleFingerprint(row)
      && String(prior.title || "") === String(row.title || "")
      && String(prior.note || "") === String(row.note || "");
    if (same) unchanged.push({ id: prior.id || null, row });
    else update.push({ id: prior.id || null, row, was: ruleFingerprint(prior) });
  }
  const gone = [];
  for (const [key, row] of existingByKey) {
    if (seen.has(key)) continue;
    if (row && row.active === false) continue;
    gone.push(row);
  }
  return { create, update, unchanged, gone, sourceUrl: sourceUrl || null };
}
