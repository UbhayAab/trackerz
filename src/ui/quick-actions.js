// ONE-TAP ROW - the things you cannot be bothered to type.
//
// Everything here writes straight to Postgres from the user's own client: no
// Gemini, no DeepSeek, no capture pipeline, no guessing. That is the point -
// these are facts the user is asserting, so the AI must not get a vote.
//
// Three groups:
//   Sleep  - "Sleeping" opens a session, "Woke up" closes it and shows the hours.
//            Duration is derived from the two timestamps, never typed.
//   Water  - +250 / +500 / +1L against today's running total, with an Undo,
//            because the only real risk of a one-tap control is a mis-tap.
//   Gym    - "Went" / "Skipped". Skipped is recorded, not ignored: that is what
//            keeps "no gym today" out of the streak while still answering the day.
//
// Every handler reports success AND failure on screen. Silent catch blocks are
// why the app previously looked like it had logged something when it had not.

import {
  logHydration, fetchHydrationTotal, undoLastHydration,
  fetchOpenSleepSession, startSleepSession, endSleepSession, adjustSleepWake,
  logGymAnswer, fetchTodayGymAnswer,
} from "../services/supabase-data.js";
import { showToast } from "./toast.js";

const HOST_ID = "quickActions";
const WATER_STEPS = [250, 500, 1000];
const WATER_GOAL_ML = 3000;

let state = { sleep: null, waterMl: 0, gym: null, busy: false };

function el(id) {
  return document.getElementById(id);
}

function fmtMl(ml) {
  return ml >= 1000 ? `${(ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 1)}L` : `${ml}ml`;
}

// "since 11:20 pm" for the open-session label.
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function hoursSince(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  return Math.max(0, Math.round(h * 10) / 10);
}

export function renderQuickActions() {
  const host = el(HOST_ID);
  if (!host) return;

  const asleep = Boolean(state.sleep);
  const pct = Math.min(100, Math.round((state.waterMl / WATER_GOAL_ML) * 100));
  const gymStatus = state.gym?.status || null;

  host.innerHTML = `
    <div class="quick-row" role="group" aria-label="Sleep">
      <span class="quick-label">Sleep</span>
      <button type="button" class="quick-btn quick-sleep${asleep ? " is-active" : ""}" data-act="sleep">
        <span class="quick-glyph" aria-hidden="true">${asleep ? "☀" : "☾"}</span>
        <span>${asleep ? "Woke up" : "Sleeping"}</span>
      </button>
      <span class="quick-note" id="quickSleepNote">${
        asleep
          ? `asleep since ${fmtTime(state.sleep.started_at)} · ${hoursSince(state.sleep.started_at)}h`
          : "tap when you go to bed"
      }</span>
    </div>

    <div class="quick-row" role="group" aria-label="Water">
      <span class="quick-label">Water</span>
      ${WATER_STEPS.map((ml) => `
        <button type="button" class="quick-btn quick-water" data-act="water" data-ml="${ml}">
          <span class="quick-glyph" aria-hidden="true">${ml >= 1000 ? "🍶" : "🥛"}</span>
          <span>+${fmtMl(ml)}</span>
        </button>`).join("")}
      <button type="button" class="quick-btn quick-undo" data-act="water-undo" ${state.waterMl ? "" : "disabled"} aria-label="Undo last water">↺</button>
      <span class="quick-note">
        <span class="quick-meter" aria-hidden="true"><span style="width:${pct}%"></span></span>
        ${fmtMl(state.waterMl)} / ${fmtMl(WATER_GOAL_ML)}
      </span>
    </div>

    <div class="quick-row" role="group" aria-label="Gym">
      <span class="quick-label">Gym</span>
      <button type="button" class="quick-btn quick-gym-yes${gymStatus === "done" ? " is-active" : ""}" data-act="gym" data-status="done">
        <span class="quick-glyph" aria-hidden="true">✓</span><span>Went</span>
      </button>
      <button type="button" class="quick-btn quick-gym-no${gymStatus === "skipped" ? " is-active" : ""}" data-act="gym" data-status="skipped">
        <span class="quick-glyph" aria-hidden="true">✕</span><span>Skipped</span>
      </button>
      <span class="quick-note">${
        gymStatus === "done" ? "logged as done today"
        : gymStatus === "skipped" ? "marked skipped - doesn't break your logging streak"
        : "answer either way; skipped still counts as logged"
      }</span>
    </div>
  `;
}

async function refresh() {
  // Each read is independent - one failing must not blank the other two.
  const [sleep, water, gym] = await Promise.allSettled([
    fetchOpenSleepSession(),
    fetchHydrationTotal(new Date()),
    fetchTodayGymAnswer(new Date()),
  ]);
  if (sleep.status === "fulfilled") state.sleep = sleep.value;
  if (water.status === "fulfilled") state.waterMl = water.value.ml;
  if (gym.status === "fulfilled") state.gym = gym.value;
  const failed = [sleep, water, gym].filter((r) => r.status === "rejected");
  if (failed.length) {
    showToast(`Couldn't load quick actions: ${failed[0].reason?.message || failed[0].reason}`, { kind: "error" });
  }
  renderQuickActions();
  maybePromptStaleSleep();
}

// If a sleep session has been open a long time you almost certainly woke and
// forgot to tap. Rather than let it grow into a fake 20-hour night, surface a
// gentle "when did you wake?" prompt so it gets resolved with a real time.
const STALE_SLEEP_HOURS = 12;
function maybePromptStaleSleep() {
  if (!state.sleep?.started_at) return;
  const openH = (Date.now() - new Date(state.sleep.started_at).getTime()) / 3600000;
  if (openH < STALE_SLEEP_HOURS) return;
  openWakeAdjuster(
    state.sleep, null, false,
    `You've been marked asleep since ${fmtTime(state.sleep.started_at)}. When did you actually wake?`,
  );
}

// A one-tap wake-time corrector. `session` is the sleep row; on save it re-closes
// the session at the chosen time. The default is "now", but the point is you can
// set 7am even if you're tapping at 11am.
function openWakeAdjuster(session, hours, capped, lead) {
  const host = el(HOST_ID);
  if (!host || !session) return;
  document.getElementById("sleepAdjuster")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "sleepAdjuster";
  wrap.className = "sleep-adjuster";
  const nowLocal = toLocalDatetimeValue(new Date());
  wrap.innerHTML = `
    <p class="sleep-adjuster-lead">${
      lead || (capped
        ? `Recorded about ${hours}h, but that looked long. When did you actually wake?`
        : `Slept ${hours}h. Woke at a different time? Set it:`)
    }</p>
    <div class="sleep-adjuster-row">
      <input type="datetime-local" id="sleepWakeInput" value="${nowLocal}" max="${nowLocal}" />
      <button type="button" class="quick-btn" id="sleepWakeSave">Save wake time</button>
      <button type="button" class="quick-btn" id="sleepWakeDismiss">Leave it</button>
    </div>
  `;
  host.appendChild(wrap);

  wrap.querySelector("#sleepWakeDismiss").addEventListener("click", () => wrap.remove());
  wrap.querySelector("#sleepWakeSave").addEventListener("click", async () => {
    const val = wrap.querySelector("#sleepWakeInput").value;
    if (!val) { wrap.remove(); return; }
    const save = wrap.querySelector("#sleepWakeSave");
    save.disabled = true; save.textContent = "Saving...";
    try {
      const res = await adjustSleepWake(session.id, new Date(val));
      showToast(`Sleep set to ${res.hours}h.`);
      wrap.remove();
      await refresh();
    } catch (err) {
      save.disabled = false; save.textContent = "Save wake time";
      showToast(`Couldn't update: ${err?.message || err}`, { kind: "error", duration: 5000 });
    }
  });
}

// A Date -> "YYYY-MM-DDTHH:MM" in LOCAL time, which is what datetime-local wants.
function toLocalDatetimeValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function withBusy(btn, fn) {
  if (state.busy) return;
  state.busy = true;
  btn?.setAttribute("disabled", "");
  try {
    await fn();
  } catch (err) {
    // Loudly. A quick action that fails quietly is worse than no button at all -
    // the user walks away believing it was recorded.
    showToast(`Didn't save: ${err?.message || err}`, { kind: "error", duration: 5000 });
  } finally {
    state.busy = false;
    btn?.removeAttribute("disabled");
    await refresh();
  }
}

export function bindQuickActions() {
  const host = el(HOST_ID);
  if (!host) return;

  host.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === "sleep") {
      await withBusy(btn, async () => {
        if (state.sleep) {
          const done = await endSleepSession();
          if (!done) { showToast("No open sleep session."); return; }
          // Wall-clock is a guess: you may have woken hours before tapping. Offer
          // the real wake time in one tap, and say plainly when we capped it.
          showToast(done.capped ? `Logged ~${done.hours}h (looked long, capped)` : `Slept ${done.hours}h - logged.`);
          openWakeAdjuster(done.row, done.hours, done.capped);
        } else {
          await startSleepSession();
          showToast("Sleep started. Tap when you wake up - or just type \"slept 7h\" later.");
        }
      });
      return;
    }

    if (act === "water") {
      const ml = Number(btn.dataset.ml) || 0;
      await withBusy(btn, async () => {
        await logHydration(ml);
        showToast(`+${fmtMl(ml)} water.`);
      });
      return;
    }

    if (act === "water-undo") {
      await withBusy(btn, async () => {
        const removed = await undoLastHydration();
        showToast(removed ? `Removed ${fmtMl(removed.ml)}.` : "Nothing to undo.");
      });
      return;
    }

    if (act === "gym") {
      const status = btn.dataset.status === "skipped" ? "skipped" : "done";
      await withBusy(btn, async () => {
        await logGymAnswer(status);
        showToast(status === "done" ? "Gym logged." : "Marked as no gym today.");
      });
    }
  });

  renderQuickActions();
  refresh();
}
