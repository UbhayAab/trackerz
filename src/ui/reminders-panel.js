// THE CALENDAR on Home, and the manage list in Settings.
//
// Two renderers over one data source. Home shows a real calendar - agenda, week
// and month, with a day detail underneath - rendered into the `#remindersStrip`
// section that already exists rather than behind a sixth nav tab.
// src/ui/calendar-panel.js explains why that trade is the right one and why the
// whole widget is hand-rolled. Settings shows every rule with its plain-English
// recurrence and a delete.
//
// Deliberately silent on Home when there is nothing scheduled at all: an empty
// "Coming up" card is a permanent piece of furniture that teaches you to stop
// looking at it. But a FAILED read is not "nothing due", and the card stays on
// screen for one - the failure shape this codebase keeps rediscovering is absent
// data rendered as a confident zero, and a calendar that VANISHES because its
// query errored has told the user they have no deadlines without even leaving a
// sentence behind. The two reads are independent (reminders, agent tasks) and so
// are their failures: either one erroring keeps the other on screen.

import { deleteReminder, setReminderActive } from "../services/supabase-data.js";
import {
  fetchCalendarReminders, fetchAgentTasks, fetchAgentTaskRuns,
  deleteAgentTask, setAgentTaskStatus,
} from "../services/jarvis.js";
import { fetchMirroredEvents } from "../services/gcal.js";
import { taskAsCalendarRow } from "../../lib/agent-tasks.mjs";
import { mirroredEventRows } from "../../lib/gcal-sync.mjs";
import { upcoming, describeRule, whenLabel, ruleProblem, minutesOfDay, formatTime } from "../../lib/reminders.mjs";
import {
  renderCalendar, calendarStatus, bindCalendar, initialCalendarState, dayItems,
  countUpcoming, escapeHtml, KIND_ICON,
} from "./calendar-panel.js";
import { showToast } from "./toast.js";

const HOME_ID = "remindersStrip";
const MANAGE_ID = "remindersManage";

let state = {
  rows: [], tasks: [], events: [], loaded: false, error: null, taskError: null,
  eventError: null, busy: false,
  cal: null,
  // { [task_id]: { loading } | { rows } | { problem } } - the run log behind a
  // scheduled check, fetched only for the day the user actually opened.
  runs: {},
};

// How far either side of today the mirrored events are read. A calendar that
// only ever fetched "from now" would lose this morning's meeting the moment it
// started, and a year forward is the same horizon the agenda can widen to.
const EVENT_BACK_DAYS = 45;
const EVENT_FORWARD_DAYS = 400;

// Reminders, the app's own scheduled tasks, and the events mirrored in from a
// connected calendar, as ONE list. The calendar renders rules; a task and a
// third-party event shaped like rules need no second renderer and therefore
// cannot drift into showing a different date from the reminder beside them. A
// task the runner will never fire again returns null and is dropped.
function calendarRows() {
  const today = todayKey();
  const taskRows = (state.tasks || [])
    .map((t) => taskAsCalendarRow(t, today))
    .filter(Boolean);
  return [...(state.rows || []), ...taskRows, ...(state.events || [])];
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
  // Third read, third independent failure: the meetings mirrored in from a
  // connected Google/ICS calendar. Until 2026-08-08 this table had a fetcher
  // (src/services/gcal.js) and no renderer at all, so connecting Google would
  // have synced a year of events into a calendar that went on showing only the
  // user's own reminder rules. Returns a Result rather than throwing, so a
  // broken mirror is a named sentence and never an empty calendar.
  try {
    const now = Date.now();
    const res = await fetchMirroredEvents({
      fromIso: new Date(now - EVENT_BACK_DAYS * 86400000).toISOString(),
      toIso: new Date(now + EVENT_FORWARD_DAYS * 86400000).toISOString(),
      limit: 500,
    });
    if (res.ok) {
      state.events = mirroredEventRows(res.value);
      state.eventError = null;
    } else {
      state.events = [];
      state.eventError = res.message || res.kind || "the calendar mirror could not be read";
    }
  } catch (err) {
    state.events = [];
    state.eventError = err?.message || String(err);
  }
  if (!state.cal) state.cal = initialCalendarState(todayKey());
  renderRemindersStrip();
  renderRemindersManage();
}

// ---- Home: the calendar ------------------------------------------------------

// The shell is written once and the calendar re-rendered inside it, because the
// live region has to OUTLIVE the content it describes: a role=status element
// created in the same breath as its own text is not reliably announced. Polite,
// never assertive - a calendar has nothing urgent enough to interrupt with.
function calendarShell(el) {
  let shell = el.querySelector(".cal-shell");
  if (!shell) {
    el.innerHTML = `<div class="cal-shell"></div><p class="cal-live visually-hidden" role="status" aria-live="polite"></p>`;
    shell = el.querySelector(".cal-shell");
  }
  return { shell, live: el.querySelector(".cal-live") };
}

export function renderRemindersStrip() {
  const el = document.getElementById(HOME_ID);
  if (!el) return;

  const rows = calendarRows();
  // Hide the card only when there is genuinely nothing AND nothing failed.
  // "Nothing scheduled" is a fact worth staying quiet about; "the read broke" is
  // not, and hiding the card on a failure is how a missed deadline gets to be
  // invisible twice.
  const quiet = state.loaded && !state.error && !state.taskError && !state.eventError
    && upcoming(rows, todayKey(), { limit: 1, withinDays: 4000 }).length === 0;
  if (quiet) { el.hidden = true; el.innerHTML = ""; return; }

  if (!state.cal) state.cal = initialCalendarState(todayKey());
  el.hidden = false;
  const { shell, live } = calendarShell(el);
  const opts = {
    error: state.error, taskError: state.taskError, eventError: state.eventError,
    loaded: state.loaded, runs: state.runs,
  };
  shell.innerHTML = renderCalendar(state.cal, rows, todayKey(), opts);
  if (live) live.textContent = calendarStatus(state.cal, rows, todayKey(), opts);

  bindCalendar(el, () => state.cal, (next) => {
    state.cal = next;
    renderRemindersStrip();
    // Opening a day is what asks for its run logs. Fetching them for every task
    // on load would be a query per task for a panel most taps never open.
    if (next.selected) loadRunsForDay(next.selected);
  }, { onRetry: retryRead });
}

// Re-run whichever read the user is asking about. A retry button that cannot say
// what it retried is a spinner with extra steps, so a task id retries just that
// task's run log and no id retries the whole calendar.
function retryRead(taskId) {
  if (taskId) {
    delete state.runs[taskId];
    fetchRuns(taskId);
    return;
  }
  state.loaded = false;
  state.error = null;
  state.taskError = null;
  state.eventError = null;
  renderRemindersStrip();
  loadReminders();
}

function loadRunsForDay(key) {
  const ids = dayItems(calendarRows(), key)
    .filter((r) => r.is_task && r.task_id)
    .map((r) => r.task_id);
  for (const id of new Set(ids)) {
    if (!state.runs[id]) fetchRuns(id);
  }
}

// A run log that failed to load must not render as "has not run yet": silence
// with a trace is a feature of this system, and a blank where the trace should
// be is the one reading the UI must never invent.
async function fetchRuns(taskId) {
  state.runs[taskId] = { loading: true };
  renderRemindersStrip();
  try {
    const runs = await fetchAgentTaskRuns(taskId, { limit: 6 });
    state.runs[taskId] = { rows: runs };
  } catch (err) {
    state.runs[taskId] = { problem: err?.message || String(err) };
  }
  renderRemindersStrip();
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
