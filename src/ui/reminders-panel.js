// COMING UP - the calendar strip on Home, and the manage list in Settings.
//
// Two renderers over one data source. Home shows the next few dates and nothing
// else; Settings shows every rule with its plain-English recurrence and a delete.
//
// Deliberately silent on Home when there is nothing due: an empty "Coming up"
// card is a permanent piece of furniture that teaches you to stop looking at it.
// A FAILED read is not the same as "nothing due" and says so - the failure shape
// this codebase keeps rediscovering is absent data rendered as a confident zero.

import { fetchReminders, deleteReminder, setReminderActive } from "../services/supabase-data.js";
import { upcoming, describeRule, whenLabel } from "../../lib/reminders.mjs";
import { showToast } from "./toast.js";

const HOME_ID = "remindersStrip";
const MANAGE_ID = "remindersManage";

let state = { rows: [], loaded: false, error: null, busy: false };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
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

const KIND_ICON = {
  birthday: "🎂", anniversary: "💍", bill: "💸", filing: "🧾",
  appointment: "📅", task: "🔔", other: "🔔",
};

export async function loadReminders() {
  try {
    state.rows = await fetchReminders();
    state.loaded = true;
    state.error = null;
  } catch (err) {
    state.error = err?.message || String(err);
    state.loaded = false;
  }
  renderRemindersStrip();
  renderRemindersManage();
}

// ---- Home: the next few dates ------------------------------------------------
export function renderRemindersStrip() {
  const el = document.getElementById(HOME_ID);
  if (!el) return;

  if (state.error) {
    el.hidden = false;
    el.innerHTML = `<p class="chips-error">Couldn't load your reminders: ${escapeHtml(state.error)}</p>`;
    return;
  }
  const next = state.loaded ? upcoming(state.rows, todayKey(), { limit: 3, withinDays: 45 }) : [];
  if (!next.length) { el.hidden = true; el.innerHTML = ""; return; }

  el.hidden = false;
  el.innerHTML = `
    <p class="chips-label">Coming up</p>
    <ul class="reminder-strip">
      ${next.map((r) => `
        <li class="reminder-item${r.days_away === 0 ? " is-today" : ""}">
          <span class="reminder-icon" aria-hidden="true">${KIND_ICON[r.kind] || "🔔"}</span>
          <span class="reminder-title">${escapeHtml(r.title)}</span>
          <span class="reminder-when">${escapeHtml(whenLabel(r.days_away))}</span>
        </li>`).join("")}
    </ul>`;
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
    el.innerHTML = `<p class="muted">No reminders yet. Say something like "my birthday is 14 August" or "remind me to file GST on the 10th of every 3rd month" in a capture and it lands here.</p>`;
    return;
  }

  const today = todayKey();
  const withNext = upcoming(state.rows, today, { limit: 200, withinDays: 4000 });
  const nextById = new Map(withNext.map((r) => [r.id, r]));

  el.innerHTML = `
    <ul class="reminder-list">
      ${state.rows.map((r) => {
        const n = nextById.get(r.id);
        // A rule with no computable next date is a real state, not a blank: say so
        // rather than render an empty cell that looks like "nothing scheduled".
        const when = r.active === false
          ? "paused"
          : n ? `next ${n.next_due_on} (${whenLabel(n.days_away)})` : "no future date";
        return `
        <li class="reminder-row${r.active === false ? " is-paused" : ""}" data-id="${escapeHtml(r.id)}">
          <span class="reminder-icon" aria-hidden="true">${KIND_ICON[r.kind] || "🔔"}</span>
          <span class="reminder-main">
            <strong>${escapeHtml(r.title)}</strong>
            <small>${escapeHtml(describeRule(r))} · ${escapeHtml(when)}${Number(r.lead_days) > 0 ? ` · ${r.lead_days}d warning` : ""}</small>
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
