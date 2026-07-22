// ONE-TAP ROW — the things you cannot be bothered to type.
//
// Everything here writes straight to Postgres from the user's own client: no
// Gemini, no DeepSeek, no capture pipeline, no guessing. That is the point —
// these are facts the user is asserting, so the AI must not get a vote.
//
// Three groups:
//   Sleep  — "Sleeping" opens a session, "Woke up" closes it and shows the hours.
//            Duration is derived from the two timestamps, never typed.
//   Water  — +250 / +500 / +1L against today's running total, with an Undo,
//            because the only real risk of a one-tap control is a mis-tap.
//   Gym    — "Went" / "Skipped". Skipped is recorded, not ignored: that is what
//            keeps "no gym today" out of the streak while still answering the day.
//
// Every handler reports success AND failure on screen. Silent catch blocks are
// why the app previously looked like it had logged something when it had not.

import {
  logHydration, fetchHydrationTotal, undoLastHydration,
  fetchOpenSleepSession, startSleepSession, endSleepSession,
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
        : gymStatus === "skipped" ? "marked skipped — doesn't break your logging streak"
        : "answer either way; skipped still counts as logged"
      }</span>
    </div>
  `;
}

async function refresh() {
  // Each read is independent — one failing must not blank the other two.
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
}

async function withBusy(btn, fn) {
  if (state.busy) return;
  state.busy = true;
  btn?.setAttribute("disabled", "");
  try {
    await fn();
  } catch (err) {
    // Loudly. A quick action that fails quietly is worse than no button at all —
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
          showToast(done ? `Slept ${done.hours}h — logged.` : "No open sleep session.");
        } else {
          await startSleepSession();
          showToast("Sleep started. Tap again when you wake up.");
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
