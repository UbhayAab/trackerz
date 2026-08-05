// RECURRING REMINDERS - the calendar the app was missing.
//
// Asked for in a note on 2026-08-04: "Set up automatic recurring reminders (like
// Google Calendar) in the backend for recurring tasks. Specifically, by next
// quarter the system should automatically remind me to file my quarterly GST
// (deadline is the 10th of Jan/Apr/Jul/Oct)." Plus the shape stated out loud:
// "birth date is 14 August" must fire every year, not once.
//
// Pure: no DOM, no Supabase, no clock reads except the `today` you pass in.
// Everything is done on YYYY-MM-DD date KEYS with integer arithmetic rather than
// Date objects, because every date bug this codebase has hit came from an
// instant being read in the wrong zone. A reminder is a calendar fact - "10 Jan"
// - not a moment, so it should never touch UTC at all.
//
// The rules, deliberately few. Anything a person actually says out loud maps to
// one of these:
//   once      - a single date ("dentist on 12 Sep")
//   daily
//   weekly    - by weekday ("every Monday")
//   monthly   - by day of month ("rent on the 5th")
//   quarterly - by day of month, anchored to a month ("GST on the 10th of
//               Jan/Apr/Jul/Oct" is month_of_year=1, day_of_month=10)
//   yearly    - by month + day ("birthday 14 August")

// ==== REMINDERS MIRROR START (byte-identical in supabase/functions/jarvis/index.ts) ====
// Plain declarations, exported once at the end - Deno cannot import repo-relative
// lib/, so the jarvis function hosts a copy and tests/mirror-parity.test.mjs proves
// the two never drift. Do not add an import to this block.
const FREQUENCIES = ["once", "daily", "weekly", "monthly", "quarterly", "yearly"];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year, month /* 1-12 */) {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

function parseKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function toKey(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// A date that does not exist lands on the last day of that month rather than
// rolling into the next one. "Rent on the 31st" in February is 28 Feb, not
// 3 March, and a 29 Feb birthday is 28 Feb in a common year. Rolling forward
// would silently move a deadline PAST itself, which for a tax filing is the one
// direction that costs money.
function clampDay(year, month, day) {
  return Math.min(Math.max(1, day), daysInMonth(year, month));
}

// Day-of-week for a date key. Sakamoto, so it needs no Date object.
const SAKAMOTO = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
function weekdayOf(key) {
  const p = parseKey(key);
  if (!p) return null;
  let { y, m, d } = p;
  if (m < 3) y -= 1;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + SAKAMOTO[m - 1] + d) % 7;
}

function addDays(key, delta) {
  const p = parseKey(key);
  if (!p) return null;
  let { y, m, d } = p;
  d += delta;
  while (d > daysInMonth(y, m)) { d -= daysInMonth(y, m); m += 1; if (m > 12) { m = 1; y += 1; } }
  while (d < 1) { m -= 1; if (m < 1) { m = 12; y -= 1; } d += daysInMonth(y, m); }
  return toKey(y, m, d);
}

function compareKeys(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function daysBetween(from, to) {
  const a = parseKey(from), b = parseKey(to);
  if (!a || !b) return null;
  const toDays = ({ y, m, d }) => {
    let n = d;
    for (let mm = 1; mm < m; mm++) n += daysInMonth(y, mm);
    for (let yy = 1970; yy < y; yy++) n += isLeapYear(yy) ? 366 : 365;
    return n;
  };
  return toDays(b) - toDays(a);
}

// The next date on or after `from` on which this rule fires. Returns null when
// the rule can never fire again (a `once` that has passed) or is unusable.
//
// `from` is inclusive: a reminder due TODAY is due today, not next year. Getting
// this backwards is how a birthday reminder fires on the 15th.
// `rule` is normalised in the body rather than via a `= {}` default: the edge
// mirror is byte-identical TypeScript, where an empty-object default infers the
// type `{}` and every property read below becomes a compile error.
function nextOccurrence(rule, from) {
  rule = rule || {};
  const start = parseKey(from);
  if (!start) return null;
  const freq = String(rule.freq || "").toLowerCase();

  if (freq === "once") {
    const on = parseKey(rule.on_date);
    if (!on) return null;
    return compareKeys(rule.on_date, from) >= 0 ? rule.on_date : null;
  }

  if (freq === "daily") return from;

  if (freq === "weekly") {
    const want = Number(rule.weekday);
    if (!Number.isInteger(want) || want < 0 || want > 6) return null;
    const have = weekdayOf(from);
    return addDays(from, (want - have + 7) % 7);
  }

  const day = Number(rule.day_of_month);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  if (freq === "monthly") {
    let { y, m } = start;
    for (let i = 0; i < 24; i++) {
      const key = toKey(y, m, clampDay(y, m, day));
      if (compareKeys(key, from) >= 0) return key;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return null;
  }

  if (freq === "quarterly" || freq === "yearly") {
    const anchor = Number(rule.month_of_year);
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 12) return null;
    const step = freq === "quarterly" ? 3 : 12;
    // Walk the anchor month forward/back in `step` jumps from the start year, and
    // also check the previous year so a January anchor is reachable from December.
    for (let y = start.y - 1; y <= start.y + 2; y++) {
      for (let m = ((anchor - 1) % step) + 1; m <= 12; m += step) {
        const key = toKey(y, m, clampDay(y, m, day));
        if (compareKeys(key, from) >= 0) return key;
      }
    }
    return null;
  }

  return null;
}

// Every occurrence in [from, to], capped. Used by the UI calendar strip.
function occurrencesBetween(rule, from, to, cap = 24) {
  rule = rule || {};
  const out = [];
  let cursor = from;
  for (let i = 0; i < cap; i++) {
    const next = nextOccurrence(rule, cursor);
    if (!next || compareKeys(next, to) > 0) break;
    out.push(next);
    cursor = addDays(next, 1);
    if (!cursor) break;
  }
  return out;
}

// How a rule reads to a human. Shown in the UI and spoken in the brief, so it
// must never say something the rule does not mean.
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeRule(rule) {
  rule = rule || {};
  const freq = String(rule.freq || "").toLowerCase();
  const day = Number(rule.day_of_month);
  const anchor = Number(rule.month_of_year);
  if (freq === "once") return rule.on_date ? `once on ${rule.on_date}` : "once";
  if (freq === "daily") return "every day";
  if (freq === "weekly") {
    const w = WEEKDAYS[Number(rule.weekday)];
    return w ? `every ${w}` : "every week";
  }
  if (freq === "monthly") return `the ${ordinal(day)} of every month`;
  if (freq === "yearly") return `every ${ordinal(day)} ${MONTHS[anchor - 1] || ""}`.trim();
  if (freq === "quarterly") {
    const months = [];
    for (let m = ((anchor - 1) % 3) + 1; m <= 12; m += 3) months.push(MONTHS[m - 1].slice(0, 3));
    return `the ${ordinal(day)} of ${months.join("/")}`;
  }
  return "";
}

// Reminders that should be SAID today: due today, or inside their lead window.
// `lead_days` is how many days of warning a thing needs - a tax filing wants a
// week, a birthday wants a day or two - and 0 means "only on the day".
function dueReminders(reminders, today, { horizon = null } = {}) {
  reminders = reminders || [];
  const out = [];
  for (const r of reminders) {
    if (!r || r.active === false) continue;
    const next = nextOccurrence(r, today);
    if (!next) continue;
    const away = daysBetween(today, next);
    if (away == null) continue;
    const lead = horizon == null ? Math.max(0, Number(r.lead_days) || 0) : horizon;
    if (away > lead) continue;
    out.push({ ...r, next_due_on: next, days_away: away });
  }
  return out.sort((a, b) => compareKeys(a.next_due_on, b.next_due_on) || String(a.title).localeCompare(String(b.title)));
}

// The next occurrence of every active reminder, soonest first. Powers the
// "Coming up" list. Unlike dueReminders this ignores lead_days.
function upcoming(reminders, today, { limit = 5, withinDays = 400 } = {}) {
  reminders = reminders || [];
  const out = [];
  for (const r of reminders) {
    if (!r || r.active === false) continue;
    const next = nextOccurrence(r, today);
    if (!next) continue;
    const away = daysBetween(today, next);
    if (away == null || away > withinDays) continue;
    out.push({ ...r, next_due_on: next, days_away: away });
  }
  out.sort((a, b) => compareKeys(a.next_due_on, b.next_due_on) || String(a.title).localeCompare(String(b.title)));
  return out.slice(0, limit);
}

// "today", "tomorrow", "in 3 days", "in 2 weeks" - the phrasing the brief uses.
function whenLabel(daysAway) {
  const n = Number(daysAway);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 14) return `in ${n} days`;
  if (n < 60) return `in ${Math.round(n / 7)} weeks`;
  return `in ${Math.round(n / 30)} months`;
}

// One line per due reminder, for the morning brief and the push body.
function reminderLines(due) {
  due = due || [];
  return due.map((r) => {
    const when = whenLabel(r.days_away);
    return `${r.title} ${when === "today" ? "is due today" : `is due ${when}`} (${r.next_due_on}).`;
  });
}
// ==== REMINDERS MIRROR END ====

export {
  FREQUENCIES,
  isLeapYear,
  daysInMonth,
  parseKey,
  toKey,
  clampDay,
  weekdayOf,
  addDays,
  compareKeys,
  daysBetween,
  nextOccurrence,
  occurrencesBetween,
  describeRule,
  dueReminders,
  upcoming,
  whenLabel,
  reminderLines,
};
