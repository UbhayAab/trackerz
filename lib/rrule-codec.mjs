// RRULE CODEC - our rule PARTS <-> RFC 5545, plus an independent expander.
//
// Deliberately NOT in the reminders mirror block. The browser needs to DISPLAY
// and export a rule; only the edge needs to parse a FOREIGN one; and the engine
// itself never touches an RRULE string. Keeping it out of the mirror keeps the
// hot path (lib/reminders.mjs, copied verbatim into the jarvis function) small -
// and lets this file do the one thing that file cannot: import a library.
//
// 2026-08-06: the RRULE text is no longer hand-assembled here. lib/rrule-engine.mjs
// translates our parts into rrule.js options and rrule.js SERIALISES them, so the
// string that leaves this app is written by the reference implementation rather
// than by our idea of it. Two bugs the hand-rolled version shipped with, both
// found the moment rrule.js was asked:
//   - a quarterly rule whose step does not divide the year ("every 9 months")
//     exported as FREQ=YEARLY;BYMONTH=1,10, which freezes a rotating pattern:
//     ten wrong dates in the first five years.
//   - INTERVAL>1 weekly rules exported with no WKST, so a calendar reading the
//     RFC default (Monday) placed "every other Sunday and Wednesday" on
//     different weeks than this app does, from the second date on.
// Three things are still ours on purpose and each says why below: the
// VALUE=DATE dtstart, the UNTIL value type, and the clamp set.
//
// ---------------------------------------------------------------------------
// THE CLAMP DIVERGENCE, which is the reason this file was written before any
// export button existed.
//
// lib/reminders.mjs clamps: "the 31st" is 28 Feb, because rolling a tax deadline
// FORWARD is the one direction that costs money. RFC 5545 does the opposite -
// `BYMONTHDAY=31` simply SKIPS February. Exported naively, "the 31st of every
// month" becomes 11 fires a year in Google Calendar against our 12, and the one
// it drops is a deadline nobody is told about. Silent, annual, and expensive.
//
// So a clamped day is exported as the set that reproduces it:
//     day 31 -> BYMONTHDAY=28,29,30,31;BYSETPOS=-1
//     day 30 -> BYMONTHDAY=28,29,30;BYSETPOS=-1
//     day 29 -> BYMONTHDAY=28,29;BYSETPOS=-1
//     day<=28 -> BYMONTHDAY=<day>            (no divergence to fix)
// BYSETPOS=-1 picks the LAST candidate that exists in that month, which is
// exactly clampDay(). This is ordinary RFC 5545 - nothing bespoke - so rrule.js
// and Google expand it to our twelve dates without being told anything.
// tests/rrule-codec.test.mjs proves the round trip THREE ways: our engine,
// rrule.js, and expandRRuleSpec() below, an expander written straight from the
// RFC rather than from our engine, so the test cannot pass by agreeing with
// itself. `fallbackRDate` is the belt-and-braces version: an explicit date list,
// which no calendar can misread.
// ---------------------------------------------------------------------------

import {
  parseKey, toKey, addDays, compareKeys, daysInMonth, weekdayOf, clampDay,
  ruleStart, dateList, minutesOfDay, ruleProblem,
} from "./reminders.mjs";
import {
  ruleToRRule, occurrencesBetween, nextOccurrence, expandICalendar,
} from "./rrule-engine.mjs";

// RFC weekday codes, index = our weekday number (0 = Sunday).
const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function icalDate(key) {
  return String(key || "").replace(/-/g, "");
}

function fromIcalDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || "").trim());
  if (!m) return null;
  const key = `${m[1]}-${m[2]}-${m[3]}`;
  return parseKey(key) ? key : null;
}

// ---------------------------------------------------------------------------
// OUR PARTS -> RFC 5545
// ---------------------------------------------------------------------------

/**
 * Serialise one reminder rule to iCalendar.
 *
 * Returns { error } when the rule cannot fire at all (ruleProblem says why) -
 * exporting a rule that does nothing would put a dead entry in someone's real
 * calendar. Otherwise: { dtstart, rrule, exdate, rdate, lines, notes }.
 *
 * The RRULE value comes from rrule.js. DTSTART is mandatory in iCalendar and is
 * also what pins an INTERVAL's phase, so a rule without one gets its first real
 * occurrence on or after `since`.
 */
export function toRRule(rule, { since = null } = {}) {
  rule = rule || {};
  const built = ruleToRRule(rule, { since: since || todayIshKey() });
  if (built.error) return { error: built.error };
  return finish({
    dtstart: built.dtstart,
    rrule: built.rrule,
    exdate: built.exdates,
    rdate: built.rdates,
    notes: built.notes,
  });
}

function finish(o) {
  // DTSTART as a DATE, not a DATE-TIME. rrule.js serialises its own dtstart as
  // 20260110T000000Z, and a calendar reading that in Asia/Kolkata puts "the
  // 10th" at 05:30 on the 10th - a timed event where the user meant a day. A
  // reminder is a calendar FACT, so it stays a date and the time of day travels
  // in the DESCRIPTION (see toICS).
  const lines = [`DTSTART;VALUE=DATE:${icalDate(o.dtstart)}`];
  if (o.rrule) lines.push(`RRULE:${o.rrule}`);
  if (o.exdate.length) lines.push(`EXDATE;VALUE=DATE:${o.exdate.map(icalDate).join(",")}`);
  if (o.rdate.length) lines.push(`RDATE;VALUE=DATE:${o.rdate.map(icalDate).join(",")}`);
  return { ...o, lines };
}

// A rule with no dtstart still has to start somewhere for export purposes. This
// is the ONE clock read in the file, isolated so every other function stays pure.
function todayIshKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * The safe fallback: the same rule as an explicit date list.
 *
 * No semantics to misread, no BYSETPOS support to depend on. Anything that can
 * read an iCalendar file at all gets our dates exactly. The cost is that it
 * stops on the last date emitted, so `years` is how far ahead it is worth
 * writing (default 3 - long enough that the next export refreshes it).
 *
 * The dates come from rrule.js, not from our engine: this is the export path,
 * and an explicit list is only "safe" if it is the standard's reading of the
 * rule rather than ours. The two are held equal by tests/rrule-engine.test.mjs.
 */
export function fallbackRDate(rule, { from = null, years = 3, cap = 200 } = {}) {
  const start = from || ruleStart(rule) || nextOccurrence(rule, todayIshKey()) || todayIshKey();
  const p = parseKey(start);
  if (!p) return { error: "no start date" };
  const to = toKey(p.y + years, p.m, clampDay(p.y + years, p.m, p.d));
  const days = occurrencesBetween(rule, start, to, cap);
  if (!days.length) return { error: "rule produces no dates in the window" };
  // A list that stopped at the cap is SHORTER than the rule, and a shorter list
  // that says nothing is a reminder that quietly ends early. Say so.
  const notes = days.length >= cap
    ? [`the date list was cut at ${cap} entries and ends on ${days[days.length - 1]}; the rule itself does not`]
    : [];
  return {
    dtstart: days[0],
    rdate: days,
    notes,
    lines: [
      `DTSTART;VALUE=DATE:${icalDate(days[0])}`,
      `RDATE;VALUE=DATE:${days.map(icalDate).join(",")}`,
    ],
  };
}

/**
 * Does this rule export as BYSETPOS over BYMONTHDAY - the clamp dialect?
 *
 * Exported so the ICS layer can pick a dialect on evidence rather than on faith.
 * MEASURED 2026-08-06 against the real parsers:
 *   rrule 2.8.1     FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1 -> 12 in 2026 (right)
 *   ical.js 2.2.1   the same rule                                   -> 38 in 2026 (wrong)
 * ical.js applies BYSETPOS only inside its BYDAY branch (recur_iterator.js
 * next_month(); issue #960, PR #985 unmerged), so the BYMONTHDAY pairing falls
 * through and every candidate day fires. ical.js is what Thunderbird ships, so
 * "the 31st of every month" becomes 38 reminders a year there. BYSETPOS with
 * BYDAY is fine in both (verified: 12 and 12), which is why nth-weekday rules
 * are unaffected - it is this one pairing.
 *
 * The dialect is still RFC-correct and stays available: rrule.js, and anything
 * that reads the spec, gets our twelve dates from it. It is just not what should
 * go in a file by default.
 */
export function needsClampDialect(rule, { since = null } = {}) {
  const out = toRRule(rule, { since });
  return !out.error && /BYSETPOS/.test(out.rrule || "") && /BYMONTHDAY/.test(out.rrule || "");
}

/**
 * A complete .ics a person can actually import. `mode` picks which body:
 *   "auto"    - RRULE, except for a rule that would need the clamp dialect, which
 *               goes out as an explicit date list. The default, and the only
 *               setting that is read correctly by both parsers for every rule.
 *   "rrule"   - always the recurrence rule (compact, recurs forever). Correct per
 *               RFC 5545 and correct in rrule.js; see needsClampDialect() for the
 *               one shape ical.js/Thunderbird gets wrong.
 *   "rdate"   - always the explicit date list (safe, finite)
 *   "both"    - RRULE with the RDATE list appended as a comment-free safety net
 *               is NOT offered: two sources for the same event double every
 *               instance in most calendars. Pick one.
 *
 * `dtstamp` is injectable because DTSTAMP is a wall-clock read and a test that
 * cannot pin it cannot assert on the file.
 */
export function toICS(rule, { title = "Reminder", mode = "auto", uid = null, since = null, dtstamp = null } = {}) {
  const useRDate = mode === "rdate" || (mode === "auto" && needsClampDialect(rule, { since }));
  const body = useRDate ? fallbackRDate(rule, { from: since }) : toRRule(rule, { since });
  if (body.error) return { error: body.error };
  const id = uid || `trackerz-${icalDate(body.dtstart)}-${String(title).replace(/[^a-z0-9]+/gi, "").slice(0, 24) || "x"}`;
  const at = minutesOfDay(rule && rule.at_time);
  const notes = [...(body.notes || [])];
  if (mode === "auto" && useRDate) {
    notes.push("exported as an explicit date list: the BYSETPOS clamp this rule needs is expanded wrongly by ical.js (Thunderbird)");
  }
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trackerz//Reminders//EN",
    "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${id}`,
    // DTSTAMP is REQUIRED in a VEVENT (RFC 5545 3.6.1) and we were not writing
    // one. Tolerant parsers accept the file anyway, which is why nobody noticed;
    // strict ones and some Exchange import paths reject it outright.
    `DTSTAMP:${icsStamp(dtstamp)}`,
    ...body.lines,
    `SUMMARY:${icsEscape(title)}`,
  ];
  // A timed reminder still exports as an all-day event plus the time in the
  // description: turning it into a floating DTSTART with a time would need a
  // VTIMEZONE, and a wrong VTIMEZONE moves a deadline. Being explicit beats
  // being clever here.
  if (at != null) lines.push(`DESCRIPTION:${icsEscape(`Fires at ${rule.at_time} ${rule.timezone || "Asia/Kolkata"}`)}`);
  if (notes.length) lines.push(`X-TRACKERZ-NOTES:${icsEscape(notes.join("; "))}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return { ics: lines.map(foldLine).join("\r\n"), dtstart: body.dtstart, notes };
}

// "20260806T053524Z". DTSTAMP is defined as UTC, always, so this is the one
// place in the codec that may look at an instant rather than a date key.
function icsStamp(when) {
  const d = when instanceof Date ? when : (when ? new Date(when) : new Date());
  const t = Number.isFinite(d.getTime()) ? d : new Date();
  return t.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/**
 * RFC 5545 3.1: a content line is at most 75 OCTETS, and longer lines are folded
 * by inserting CRLF plus a single space. Measured before this existed: the RDATE
 * line of a three-year export ran to 340 octets in one line.
 *
 * Octets, not characters - a title with an emoji or a Devanagari name is
 * multi-byte, and folding by string length would both overshoot the limit and,
 * worse, split a UTF-8 sequence across the fold. So the walk is over encoded
 * bytes and only ever breaks between whole code points.
 */
function foldLine(line) {
  const s = String(line);
  if (octets(s) <= 75) return s;
  const out = [];
  let chunk = "";
  let used = 0;
  let budget = 75;
  for (const ch of s) {            // iterates code points, never half a surrogate pair
    const size = octets(ch);
    if (used + size > budget) {
      out.push(chunk);
      chunk = "";
      used = 0;
      budget = 74;                 // a continuation line spends one octet on its leading space
    }
    chunk += ch;
    used += size;
  }
  if (chunk) out.push(chunk);
  return out.join("\r\n ");
}

// UTF-8 byte length without node:buffer - lib/ must run unchanged in the browser.
const UTF8 = new TextEncoder();
function octets(s) {
  return UTF8.encode(s).length;
}

function icsEscape(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// RFC 5545 -> a spec, and an INDEPENDENT expander over it
//
// Written from the RFC rather than from lib/reminders.mjs on purpose: the whole
// point of the round-trip test is to catch our engine and the standard
// disagreeing, and an expander that reuses our engine could never do that.
// ---------------------------------------------------------------------------

/** Parse "DTSTART…/RRULE…/EXDATE…/RDATE…" (any order, one per line, or a bare RRULE). */
export function parseICalendar(text) {
  const spec = {
    dtstart: null, freq: "", interval: 1, byMonth: [], byMonthDay: [], byDay: [],
    bySetPos: [], until: null, count: null, wkst: "MO", exdates: [], rdates: [],
  };
  const warnings = [];
  const src = String(text || "").replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  for (const rawLine of src) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).split(";")[0].toUpperCase();
    const value = line.slice(colon + 1).trim();
    if (name === "DTSTART") spec.dtstart = fromIcalDate(value);
    else if (name === "EXDATE") spec.exdates.push(...value.split(",").map(fromIcalDate).filter(Boolean));
    else if (name === "RDATE") spec.rdates.push(...value.split(",").map(fromIcalDate).filter(Boolean));
    else if (name === "RRULE") applyRRuleText(spec, value, warnings);
  }
  // A bare "FREQ=…" with no RRULE: prefix is what most people paste.
  if (!spec.freq && /FREQ=/i.test(text || "")) applyRRuleText(spec, String(text), warnings);
  return { spec, warnings };
}

function applyRRuleText(spec, value, warnings) {
  for (const pair of String(value).split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim().toUpperCase();
    const v = pair.slice(eq + 1).trim();
    if (k === "FREQ") spec.freq = v.toUpperCase();
    else if (k === "INTERVAL") spec.interval = Math.max(1, Number(v) || 1);
    else if (k === "COUNT") spec.count = Math.max(1, Number(v) || 1);
    else if (k === "UNTIL") spec.until = fromIcalDate(v);
    else if (k === "WKST") spec.wkst = v.toUpperCase();
    else if (k === "BYMONTH") spec.byMonth = numList(v);
    else if (k === "BYMONTHDAY") spec.byMonthDay = numList(v);
    else if (k === "BYSETPOS") spec.bySetPos = numList(v);
    else if (k === "BYDAY") spec.byDay = v.split(",").map(parseByDay).filter(Boolean);
    else if (k === "BYYEARDAY" || k === "BYWEEKNO" || k === "BYHOUR" || k === "BYMINUTE" || k === "BYSECOND") {
      // Silently dropping one of these would change which dates fire, so it is
      // reported instead. An unreadable part of a rule is not an absent one.
      warnings.push(`${k} is not supported and was ignored`);
    }
  }
}

function numList(v) {
  return String(v).split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x));
}

function parseByDay(token) {
  const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(String(token).trim());
  if (!m) return null;
  return { nth: m[1] ? Number(m[1]) : 0, wd: ICAL_DAYS.indexOf(m[2].toUpperCase()) };
}

const WKST_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Expand a parsed spec into date keys in [from, to]. Straight RFC 5545:
 * build each period's candidate set, apply BYSETPOS to that set, then filter by
 * DTSTART / UNTIL / COUNT. Date-valued only - we never emit times into an RRULE.
 */
export function expandRRuleSpec(spec, from, to, cap = 400) {
  const out = [];
  if (!spec || !spec.dtstart) return out;
  const start = parseKey(spec.dtstart);
  if (!start) return out;
  const freq = String(spec.freq || "").toUpperCase();
  const step = Math.max(1, Number(spec.interval) || 1);
  const ex = new Set(spec.exdates || []);
  const limit = spec.count ? Math.min(cap, spec.count) : cap;

  // No RRULE at all: DTSTART plus any RDATEs is the whole set.
  if (!freq) {
    const only = [spec.dtstart, ...(spec.rdates || [])].filter((k) => !ex.has(k));
    return dedupeSorted(only).filter((k) => compareKeys(k, from) >= 0 && compareKeys(k, to) <= 0);
  }

  let emitted = 0;
  const maxPeriods = 3000;
  for (let p = 0; p < maxPeriods && emitted < limit; p++) {
    const cands = periodCandidates(freq, spec, start, p * step);
    if (cands === null) break;
    const picked = applySetPos(cands, spec.bySetPos);
    let pastWindow = true;
    for (const key of picked) {
      if (compareKeys(key, spec.dtstart) < 0) { pastWindow = false; continue; }
      if (spec.until && compareKeys(key, spec.until) > 0) { emitted = limit; break; }
      emitted++;                       // COUNT sizes the set BEFORE EXDATE removal
      if (emitted > limit) break;
      if (compareKeys(key, to) > 0) { pastWindow = true; continue; }
      pastWindow = false;
      if (compareKeys(key, from) < 0) continue;
      if (ex.has(key)) continue;
      out.push(key);
    }
    // Every candidate in this period is already past `to` and nothing new can
    // land before it - stop rather than walking 3000 empty periods.
    if (pastWindow && picked.length && compareKeys(picked[0], to) > 0) break;
  }

  for (const k of spec.rdates || []) {
    if (ex.has(k)) continue;
    if (compareKeys(k, from) < 0 || compareKeys(k, to) > 0) continue;
    out.push(k);
  }
  return dedupeSorted(out);
}

function dedupeSorted(keys) {
  const seen = new Set();
  const out = [];
  for (const k of [...keys].sort(compareKeys)) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// BYSETPOS selects positions within ONE period's candidate set. -1 is the last.
function applySetPos(cands, setPos) {
  if (!setPos || !setPos.length) return cands;
  const out = [];
  for (const pos of setPos) {
    const i = pos > 0 ? pos - 1 : cands.length + pos;
    if (i >= 0 && i < cands.length) out.push(cands[i]);
  }
  return out.sort(compareKeys);
}

// The candidate dates of period `offset` (in FREQ units) after DTSTART's period.
function periodCandidates(freq, spec, start, offset) {
  if (freq === "DAILY") {
    const key = addDays(spec.dtstart, offset);
    if (!key) return null;
    return filterDay(key, spec) ? [key] : [];
  }
  if (freq === "WEEKLY") {
    const wkst = WKST_INDEX[spec.wkst] ?? 1;
    const startWd = weekdayOf(spec.dtstart);
    const weekStart = addDays(spec.dtstart, -(((startWd - wkst) + 7) % 7));
    const base = addDays(weekStart, offset * 7);
    if (!base) return null;
    const wds = spec.byDay.length ? spec.byDay.map((d) => d.wd) : [startWd];
    const out = [];
    for (let i = 0; i < 7; i++) {
      const key = addDays(base, i);
      if (wds.indexOf(weekdayOf(key)) === -1) continue;
      if (!filterDay(key, spec)) continue;
      out.push(key);
    }
    return out.sort(compareKeys);
  }
  if (freq === "MONTHLY") {
    const idx = start.y * 12 + (start.m - 1) + offset;
    return monthCandidates(Math.floor(idx / 12), (idx % 12) + 1, spec, start);
  }
  if (freq === "YEARLY") {
    const y = start.y + offset;
    if (y > 9000) return null;
    const months = spec.byMonth.length ? spec.byMonth : [start.m];
    let out = [];
    for (const m of months) out = out.concat(monthCandidates(y, m, spec, start));
    return out.sort(compareKeys);
  }
  return null;
}

function monthCandidates(y, m, spec, start) {
  if (y < 1 || y > 9000) return [];
  if (spec.byMonth.length && spec.byMonth.indexOf(m) === -1) return [];
  const dim = daysInMonth(y, m);
  const out = [];
  if (spec.byDay.length) {
    for (const { nth, wd } of spec.byDay) {
      if (nth === 0) {
        for (let d = 1; d <= dim; d++) if (weekdayOf(toKey(y, m, d)) === wd) out.push(toKey(y, m, d));
      } else {
        const hits = [];
        for (let d = 1; d <= dim; d++) if (weekdayOf(toKey(y, m, d)) === wd) hits.push(toKey(y, m, d));
        const i = nth > 0 ? nth - 1 : hits.length + nth;
        if (i >= 0 && i < hits.length) out.push(hits[i]);
      }
    }
    // BYMONTHDAY alongside BYDAY is an INTERSECTION in RFC 5545.
    if (spec.byMonthDay.length) {
      const wanted = new Set(spec.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)));
      return out.filter((k) => wanted.has(parseKey(k).d)).sort(compareKeys);
    }
    return out.sort(compareKeys);
  }
  const days = spec.byMonthDay.length ? spec.byMonthDay : [start.d];
  for (const raw of days) {
    const d = raw > 0 ? raw : dim + raw + 1;
    // The RFC's own behaviour: a day that does not exist in this month is simply
    // not a candidate. This is the divergence the clamp set above works around.
    if (d >= 1 && d <= dim) out.push(toKey(y, m, d));
  }
  return out.sort(compareKeys);
}

function filterDay(key, spec) {
  const p = parseKey(key);
  if (!p) return false;
  if (spec.byMonth.length && spec.byMonth.indexOf(p.m) === -1) return false;
  if (spec.byMonthDay.length) {
    const dim = daysInMonth(p.y, p.m);
    const wanted = spec.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1));
    if (wanted.indexOf(p.d) === -1) return false;
  }
  if (spec.byDay.length && spec.byDay.every((d) => d.wd !== weekdayOf(key))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// RFC 5545 -> our parts (importing someone else's calendar)
// ---------------------------------------------------------------------------

/**
 * Best-effort map of a foreign RRULE onto our rule parts.
 *
 * `lossy` lists everything the engine cannot represent. A caller that ignores it
 * gets a reminder that fires on the wrong dates and says nothing about it, so
 * src/ui/calendar-panel.js surfaces it and the edge function refuses the import.
 *
 * The mapping is CHECKED, not assumed: whatever comes out is exported again and
 * both readings are expanded by rrule.js, so a part we mapped wrongly - or one
 * nobody thought to list here - shows up as a named date rather than as a
 * reminder that quietly fires on the wrong day. See roundTripLoss() below.
 */
export function parseRRule(text) {
  const { spec, warnings } = parseICalendar(text);
  const lossy = [...warnings];
  const freq = String(spec.freq || "").toUpperCase();
  const rule = { dtstart: spec.dtstart || null };
  if (spec.exdates.length) rule.exdates = dateList(spec.exdates);
  if (spec.rdates.length) rule.rdates = dateList(spec.rdates);
  if (spec.until) rule.until = spec.until;
  if (spec.count) rule.count = spec.count;

  if (!freq) {
    if (!spec.dtstart) return { rule: null, spec, lossy: [...lossy, "no DTSTART and no FREQ"] };
    rule.freq = "once";
    rule.on_date = spec.dtstart;
    return { rule, spec, lossy: [...lossy, ...roundTripLoss(text, rule)] };
  }

  if (freq === "DAILY") {
    rule.freq = "daily";
    rule.interval = spec.interval;
  } else if (freq === "WEEKLY") {
    rule.freq = "weekly";
    rule.interval = spec.interval;
    rule.weekdays = spec.byDay.length
      ? spec.byDay.map((d) => d.wd)
      : (spec.dtstart ? [weekdayOf(spec.dtstart)] : []);
    if (spec.byDay.some((d) => d.nth !== 0)) lossy.push("BYDAY position on a WEEKLY rule is ignored");
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const yearly = freq === "YEARLY";
    // INTERVAL=3 monthly IS our "quarterly"; anything else stays monthly with an
    // interval, which the engine handles natively.
    if (yearly) {
      rule.freq = spec.byMonth.length > 1 ? "quarterly" : "yearly";
      rule.interval = spec.interval;
      rule.month_of_year = spec.byMonth.length ? Math.min(...spec.byMonth) : (spec.dtstart ? parseKey(spec.dtstart).m : null);
      if (spec.byMonth.length > 1 && spec.byMonth.length !== 4) {
        lossy.push(`BYMONTH=${spec.byMonth.join(",")} is not a quarterly pattern; only the first month is kept`);
      }
    } else if (spec.interval === 3) {
      rule.freq = "quarterly";
      rule.interval = 1;
      rule.month_of_year = spec.dtstart ? parseKey(spec.dtstart).m : null;
    } else {
      rule.freq = "monthly";
      rule.interval = spec.interval;
    }
    const nth = spec.byDay.find((d) => d.nth !== 0);
    if (nth) {
      rule.nth_weekday = nth.nth;
      rule.weekday = nth.wd;
      if (spec.byDay.length > 1) lossy.push("only the first BYDAY position is kept");
    } else if (spec.byMonthDay.length) {
      // The clamp set we emit, read back: BYSETPOS=-1 over a run ending at N is
      // exactly "the Nth, clamped". Recognising our own dialect is what makes the
      // round trip lossless instead of turning day 31 into day 28.
      const sorted = [...spec.byMonthDay].sort((a, b) => a - b);
      const isClampSet = spec.bySetPos.length === 1 && spec.bySetPos[0] === -1
        && sorted[0] === 28 && sorted[sorted.length - 1] > 28
        && sorted.every((d, i) => d === 28 + i);
      if (isClampSet) rule.day_of_month = sorted[sorted.length - 1];
      else if (sorted.length === 1 && sorted[0] > 0) rule.day_of_month = sorted[0];
      else if (sorted.length === 1 && sorted[0] === -1) {
        rule.day_of_month = 31;
        lossy.push("BYMONTHDAY=-1 (last day) was stored as day 31, which this engine clamps to the month end");
      } else {
        rule.day_of_month = sorted[sorted.length - 1];
        lossy.push(`BYMONTHDAY=${spec.byMonthDay.join(",")} has ${sorted.length} days; only ${rule.day_of_month} is kept`);
      }
    } else if (spec.dtstart) {
      rule.day_of_month = parseKey(spec.dtstart).d;
    }
    if (spec.byDay.length && spec.byMonthDay.length) lossy.push("BYDAY combined with BYMONTHDAY is not representable");
  } else {
    return { rule: null, spec, lossy: [...lossy, `FREQ=${freq} is not supported`] };
  }

  const problem = ruleProblem(rule);
  if (problem) return { rule: null, spec, lossy: [...lossy, problem] };
  return { rule, spec, lossy: [...lossy, ...roundTripLoss(text, rule)] };
}

/**
 * Expand the SOURCE rule and OUR mapping of it with rrule.js and name the first
 * date they disagree on.
 *
 * The list of `lossy` reasons above is hand-written, which means it can only
 * report the losses somebody anticipated. WKST is the case that proves it: a
 * foreign "every other Monday and Sunday" counts its weeks from Monday, this
 * engine counts them from Sunday, nothing in the mapping above notices, and the
 * imported reminder is a week out from the second date on. Asking the reference
 * implementation whether the two rules produce the same dates catches that
 * class without anybody having to think of it first.
 *
 * Five years is the horizon: long enough for an interval or a leap year to
 * separate two rules that agree at first, short enough to stay cheap.
 */
function roundTripLoss(text, rule, { years = 5, cap = 120 } = {}) {
  const p = parseKey(rule && rule.dtstart) || parseKey(rule && rule.on_date);
  if (!p) return [];
  const from = toKey(p.y, p.m, p.d);
  const to = toKey(p.y + years, p.m, clampDay(p.y + years, p.m, p.d));

  const mine = toRRule(rule, { since: from });
  if (mine.error) return [`this engine cannot re-export the imported rule: ${mine.error}`];
  const source = expandICalendar(text, from, to, cap);
  const ours = expandICalendar(mine.lines.join("\r\n"), from, to, cap);
  // rrule.js refusing to read the source at all is the caller's problem to see,
  // not something to swallow into a silent "imported fine".
  if (source.error) return [`rrule.js could not expand the source rule: ${source.error}`];
  if (ours.error) return [`rrule.js could not expand the imported rule: ${ours.error}`];

  const n = Math.max(source.dates.length, ours.dates.length);
  for (let i = 0; i < n; i++) {
    const a = source.dates[i], b = ours.dates[i];
    if (a === b) continue;
    return [`imported rule fires on ${b || "nothing"} where the source fires on ${a || "nothing"} (occurrence ${i + 1} of ${n} in ${years} years)`];
  }
  return [];
}
