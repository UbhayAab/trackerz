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
import { fetchCalendarReminders, fetchAgentTasks, deleteAgentTask, setAgentTaskStatus } from "../services/jarvis.js";
import { taskAsCalendarRow } from "../../lib/agent-tasks.mjs";
import { upcoming, describeRule, whenLabel, ruleProblem, minutesOfDay, formatTime } from "../../lib/reminders.mjs";
import {
  renderCalendar, bindCalendar, initialCalendarState, countUpcoming, escapeHtml, KIND_ICON,
} from "./calendar-panel.js";
import { showToast } from "./toast.js";

const HOME_ID = "remindersStrip";
const MANAGE_ID = "remindersManage";

let state = { rows: [], tasks: [], loaded: false, error: null, taskError: null, busy: false, cal: null };

// Reminders and the app's own scheduled tasks, as ONE list of rules. The
// calendar renders rules; a task shaped like a rule needs no second renderer and
// therefore cannot drift into showing a different date from the reminder beside
// it. A task the runner will never fire again returns null and is dropped.
function calendarRows() {
  const today = todayKey();
  const taskRows = (state.tasks || [])
    .map((t) => taskAsCalendarRow(t, today))
    .filter(Boolean);
  return [...(state.rows || []), ...taskRows];
}

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
  // Tasks are fetched separately and fail separately. A calendar that hides
  // every reminder because the task table errored would be a worse outage than
  // the one it is reporting - and a task list that silently renders empty on a
  // failed read is this codebase's oldest bug, so the error is kept and shown.
  try {
    state.tasks = await fetchAgentTasks({ limit: 100 });
    state.taskError = null;
  } catch (err) {
    state.tasks = [];
    state.taskError = err?.message || String(err);
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
  const rows = calendarRows();
  const anything = state.loaded && upcoming(rows, todayKey(), { limit: 1, withinDays: 4000 }).length > 0;
  if (!anything) { el.hidden = true; el.innerHTML = ""; return; }

  if (!state.cal) state.cal = initialCalendarState(todayKey());
  el.hidden = false;
  el.innerHTML = renderCalendar(state.cal, rows, todayKey(), { error: null, loaded: state.loaded })
    + (state.taskError ? `<p class="chips-error">Scheduled checks couldn't be loaded: ${escapeHtml(state.taskError)}</p>` : "");
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
  if (!state.rows.length && !(state.tasks || []).length) {
    el.innerHTML = `<p class="muted">No reminders yet. Say something like "my birthday is 14 August", "remind me to file GST on the 10th of every 3rd month", or "every other Wednesday at 18:30 call mum" in a capture and it lands here. To have the app CHECK something for you instead of just telling you, say "every Sunday evening review my spending".</p>`;
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
    </ul>
    ${renderTaskList()}`;
}

// ---- Settings: the app's own scheduled checks --------------------------------
//
// Separate list, not mixed into the reminder rows, because the two answer
// different questions: a reminder is something the user wrote, a task is
// something the app will go and DO. Mixing them would hide the only list where
// "what is this thing allowed to do while I am not looking" is answerable.
function renderTaskList() {
  if (state.taskError) {
    return `<p class="chips-error">Scheduled checks couldn't be loaded: ${escapeHtml(state.taskError)}</p>`;
  }
  const tasks = state.tasks || [];
  if (!tasks.length) return "";
  const today = todayKey();
  return `
    <h3 class="reminder-subhead">Checks the app runs itself</h3>
    <ul class="reminder-list">
      ${tasks.map((t) => {
        const row = taskAsCalendarRow(t, today);
        const when = t.status !== "scheduled"
          ? t.status
          : row ? `next ${(row.on_date || row.dtstart || "").slice(0, 10) || describeRule(row)}` : "no future date";
        const at = row ? minutesOfDay(row.at_time) : null;
        // A tripped breaker is the whole reason this list exists. Three failures
        // in a row disables a task, and a disabled task that looks identical to a
        // quiet one is indistinguishable from "nothing was due".
        const broken = t.status === "disabled" || Number(t.consecutive_failures) >= 3;
        return `
        <li class="reminder-row${t.status !== "scheduled" ? " is-paused" : ""}" data-task-id="${escapeHtml(t.id)}">
          <span class="reminder-icon" aria-hidden="true">🤖</span>
          <span class="reminder-main">
            <strong>${escapeHtml(row ? row.title : String(t.prompt || "").slice(0, 60))}</strong>
            <small><span class="reminder-next">${escapeHtml(t.intent || "check")}</span> · ${escapeHtml(when)}${
              at != null ? ` · at ${escapeHtml(formatTime(at))}` : ""
            }${Number(t.runs) > 0 ? ` · ran ${t.runs}x` : " · never run"}${
              t.created_by === "agent" ? " · scheduled from a capture" : ""
            }</small>
            ${broken ? `<small class="reminder-warn">Stopped after repeated failures${t.disabled_reason ? `: ${escapeHtml(t.disabled_reason)}` : ""}</small>` : ""}
          </span>
          <span class="reminder-actions">
            <button type="button" class="linklike" data-task-act="toggle">${t.status === "scheduled" ? "Pause" : "Resume"}</button>
            <button type="button" class="linklike danger" data-task-act="delete">Delete</button>
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
    const taskBtn = ev.target.closest("button[data-task-act]");
    if (taskBtn) { await handleTaskAction(taskBtn); return; }
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

async function handleTaskAction(btn) {
  if (state.busy) return;
  const id = btn.closest("[data-task-id]")?.dataset.taskId;
  const task = (state.tasks || []).find((t) => t.id === id);
  if (!task) return;
  state.busy = true;
  try {
    if (btn.dataset.taskAct === "delete") {
      await deleteAgentTask(id);
      state.tasks = state.tasks.filter((t) => t.id !== id);
      showToast("Deleted that scheduled check");
    } else {
      const next = task.status === "scheduled" ? "disabled" : "scheduled";
      await setAgentTaskStatus(id, next);
      task.status = next;
      // Resuming clears the breaker server-side; mirror that here so the row
      // does not keep showing "stopped after repeated failures" until a reload.
      if (next === "scheduled") { task.consecutive_failures = 0; task.disabled_reason = null; }
      showToast(next === "scheduled" ? "Resumed" : "Paused");
    }
    renderRemindersManage();
    renderRemindersStrip();
  } catch (err) {
    showToast(`Couldn't update: ${err?.message || err}`);
  } finally {
    state.busy = false;
  }
}
