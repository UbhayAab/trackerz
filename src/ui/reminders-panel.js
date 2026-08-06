// THE CALENDAR on Home, and the manage list in Settings.
//
// Two renderers over one data source. Home now shows a real calendar - an agenda
// of the next three weeks with a month-grid toggle - rendered into the
// `#remindersStrip` section that already exists, rather than behind a sixth nav
// tab. src/ui/calendar-panel.js explains why that trade is the right one.
// Settings shows every rule with its plain-English recurrence and a delete.
//
// Deliberately silent on Home when there is nothing scheduled at all: an empty
// "Coming up" card is a permanent piece of furniture that teaches you to stop
// looking at it. A FAILED read is not the same as "nothing due" and says so -
// the failure shape this codebase keeps rediscovering is absent data rendered as
// a confident zero, and a calendar showing an empty month because the query
// errored has just told the user they have no deadlines.

import { deleteReminder, setReminderActive } from "../services/supabase-data.js";
import { fetchCalendarReminders } from "../services/jarvis.js";
import { upcoming, describeRule, whenLabel, ruleProblem, minutesOfDay, formatTime } from "../../lib/reminders.mjs";
import {
  renderCalendar, bindCalendar, initialCalendarState, countUpcoming, escapeHtml, KIND_ICON,
} from "./calendar-panel.js";
import { showToast } from "./toast.js";

const HOME_ID = "remindersStrip";
const MANAGE_ID = "remindersManage";

let state = { rows: [], loaded: false, error: null, busy: false, cal: null };

// Today in IST as a YYYY-MM-DD key. The whole engine works on calendar keys, so
// the ONE place a clock is read is here, and it is read in the user's zone.
export function todayKey(now = new Date(), timeZone = "Asia/Kolkata") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function loadReminders() {
  try {
    // The calendar-specific column list: a rule read WITHOUT its interval or its
    // nth_weekday silently degrades to a different, wrong rule.
    state.rows = await fetchCalendarReminders();
    state.loaded = true;
    state.error = null;
  } catch (err) {
    state.error = err?.message || String(err);
    state.loaded = false;
  }
  if (!state.cal) state.cal = initialCalendarState(todayKey());
  renderRemindersStrip();
  renderRemindersManage();
}

// ---- Home: the calendar ------------------------------------------------------
export function renderRemindersStrip() {
  const el = document.getElementById(HOME_ID);
  if (!el) return;

  if (state.error) {
    el.hidden = false;
    el.innerHTML = `<p class="chips-error">Couldn't load your calendar: ${escapeHtml(state.error)}</p>`;
    return;
  }
  // Nothing scheduled AT ALL (not "nothing this month") is the only case that
  // hides the card, so paging to a quiet month does not make the calendar vanish
  // under the user's finger.
  const anything = state.loaded && upcoming(state.rows, todayKey(), { limit: 1, withinDays: 4000 }).length > 0;
  if (!anything) { el.hidden = true; el.innerHTML = ""; return; }

  if (!state.cal) state.cal = initialCalendarState(todayKey());
  el.hidden = false;
  el.innerHTML = renderCalendar(state.cal, state.rows, todayKey(), { error: null, loaded: state.loaded });
  bindCalendar(el, () => state.cal, (next) => {
    state.cal = next;
    renderRemindersStrip();
  });
}

// ---- Settings: the full list -------------------------------------------------
export function renderRemindersManage() {
  const el = document.getElementById(MANAGE_ID);
  if (!el) return;

  if (state.error) {
    el.innerHTML = `<p class="chips-error">Couldn't load your reminders: ${escapeHtml(state.error)}</p>`;
    return;
  }
  if (!state.loaded) { el.innerHTML = `<p class="muted">Loading…</p>`; return; }
  if (!state.rows.length) {
    el.innerHTML = `<p class="muted">No reminders yet. Say something like "my birthday is 14 August", "remind me to file GST on the 10th of every 3rd month", or "every other Wednesday at 18:30 call mum" in a capture and it lands here.</p>`;
    return;
  }

  const today = todayKey();
  const withNext = upcoming(state.rows, today, { limit: 200, withinDays: 4000 });
  const nextById = new Map(withNext.map((r) => [r.id, r]));

  el.innerHTML = `
    <ul class="reminder-list">
      ${state.rows.map((r) => {
        const n = nextById.get(r.id);
        // A rule with no computable next date is a real state, not a blank: say
        // so, and say WHY. ruleProblem() turns "this quietly never fires" into a
        // sentence, which is the difference between a bug and a fixable setting.
        const problem = ruleProblem(r);
        const when = r.active === false
          ? "paused"
          : n ? `next ${n.next_due_on} (${whenLabel(n.days_away)})` : "no future date";
        const times = n ? countUpcoming(r, today, 365) : 0;
        const at = minutesOfDay(r.at_time);
        return `
        <li class="reminder-row${r.active === false ? " is-paused" : ""}" data-id="${escapeHtml(r.id)}">
          <span class="reminder-icon" aria-hidden="true">${KIND_ICON[r.kind] || "🔔"}</span>
          <span class="reminder-main">
            <strong>${escapeHtml(r.title)}</strong>
            <small><span class="reminder-next">${escapeHtml(describeRule(r))}</span> · ${escapeHtml(when)}${
              Number(r.lead_days) > 0 ? ` · ${r.lead_days}d warning` : ""
            }${at != null ? ` · fires at ${escapeHtml(formatTime(at))}` : " · announced in the 07:00 brief"}${
              times > 1 ? ` · ${times}x in the next year` : ""
            }</small>
            ${problem ? `<small class="reminder-warn">This rule cannot fire: ${escapeHtml(problem)}</small>` : ""}
            ${r.note ? `<small class="reminder-note">${escapeHtml(r.note)}</small>` : ""}
          </span>
          <span class="reminder-actions">
            <button type="button" class="linklike" data-act="toggle">${r.active === false ? "Resume" : "Pause"}</button>
            <button type="button" class="linklike danger" data-act="delete">Delete</button>
          </span>
        </li>`;
      }).join("")}
    </ul>`;
}

export function bindRemindersPanel() {
  const el = document.getElementById(MANAGE_ID);
  if (!el || el.dataset.bound === "1") return;
  el.dataset.bound = "1";
  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn || state.busy) return;
    const row = btn.closest(".reminder-row");
    const id = row?.dataset.id;
    if (!id) return;
    const rec = state.rows.find((r) => r.id === id);
    if (!rec) return;

    state.busy = true;
    try {
      if (btn.dataset.act === "delete") {
        await deleteReminder(id);
        state.rows = state.rows.filter((r) => r.id !== id);
        showToast(`Deleted "${rec.title}"`);
      } else {
        const next = rec.active === false;
        await setReminderActive(id, next);
        rec.active = next;
        showToast(next ? `Resumed "${rec.title}"` : `Paused "${rec.title}"`);
      }
      renderRemindersManage();
      renderRemindersStrip();
    } catch (err) {
      showToast(`Couldn't update: ${err?.message || err}`);
    } finally {
      state.busy = false;
    }
  });
}
