// Pure date helpers for the diet hub's day navigation (stepper + <input type=date>
// + the swipeable strip of recent days). No DOM, no Supabase - importable by the
// UI and by tests.
//
// Everything works in LOCAL calendar days on purpose: the rest of the diet hub
// (fetchDayLogs, plan.js, the check-off state keys) already buckets by the
// device's local day, and the owner's device is Asia/Kolkata. Mixing a UTC key in
// here would silently shift late-evening logs to the next day.
//
// The one rule this module exists to protect: a day whose log status we could not
// READ must never look like a day with nothing logged. `dayDotState` returns
// "unknown" for that case, and the caller renders it differently from "empty".

export function startOfLocalDay(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(date, n) {
  const d = startOfLocalDay(date);
  d.setDate(d.getDate() + n);
  return d;
}

// "YYYY-MM-DD" in local time (NOT toISOString, which is UTC).
export function dayKeyOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Parse "YYYY-MM-DD" (what <input type="date"> gives us) as LOCAL midnight.
// `new Date("2026-07-20")` would parse as UTC midnight and land on the 19th here.
export function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  // Reject impossible dates ("2026-02-31" rolls over to March in the Date ctor).
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return date;
}

export function isSameDay(a, b) {
  return dayKeyOf(a) === dayKeyOf(b);
}

// The future has not happened yet - never let the view land there, because the
// hub would then show a plan for a day that cannot have any logs.
export function clampToToday(date, today = new Date()) {
  const d = startOfLocalDay(date);
  const t = startOfLocalDay(today);
  return d > t ? t : d;
}

// The strip: `count` days ending on today, OLDEST FIRST so today sits at the
// right edge (the phone scrolls back leftwards into the past).
export function buildDayStrip(today = new Date(), count = 14) {
  const t = startOfLocalDay(today);
  const n = Math.max(1, Math.floor(count));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(t, -i);
    out.push({
      key: dayKeyOf(date),
      date,
      dow: date.toLocaleDateString("en-IN", { weekday: "short" }),
      dom: date.getDate(),
      month: date.toLocaleDateString("en-IN", { month: "short" }),
      isToday: i === 0,
      offset: i === 0 ? 0 : -i, // avoid -0 leaking into keys/labels
    });
  }
  return out;
}

// Fold one or more row lists ([{ occurred_at }]) into the set of local day keys
// that have at least one row. A row with no timestamp is NOT counted - we can't
// place it on a day, and guessing would put a mark on a day it may not belong to.
export function loggedDayKeys(rowLists = []) {
  const keys = new Set();
  for (const rows of rowLists) {
    for (const row of rows || []) {
      const iso = row?.occurred_at;
      if (!iso) continue;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      keys.add(dayKeyOf(d));
    }
  }
  return keys;
}

// "logged" | "empty" | "unknown". `presence` is null/undefined when the lookup
// never succeeded (offline, signed out, query failed) - that is NOT "empty".
export function dayDotState(key, presence) {
  if (!presence) return "unknown";
  return presence.has(key) ? "logged" : "empty";
}

// Label for the stepper: "Today", "Yesterday", else "Mon, 20 Jul".
export function dayLabel(date, today = new Date()) {
  const d = startOfLocalDay(date);
  const t = startOfLocalDay(today);
  if (isSameDay(d, t)) return "Today";
  if (isSameDay(d, addDays(t, -1))) return "Yesterday";
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}
