// ONE-TAP ROW - the things you cannot be bothered to type.
//
// Everything here writes straight to Postgres from the user's own client: no
// Gemini, no DeepSeek, no capture pipeline, no guessing. That is the point -
// these are facts the user is asserting, so the AI must not get a vote.
//
// Three groups:
//   Sleep  - "Sleeping" opens a session, "Woke up" closes it and shows the hours.
//            Duration is derived from the two timestamps, never typed.
//   Water  - ONE circular drop button that fills up as the day goes on. Tap it as
//            many times as you drank; long-press for 500 / 1L / custom / goal.
//   Gym    - "Went" / "Skipped". Skipped is recorded, not ignored: that is what
//            keeps "no gym today" out of the streak while still answering the day.
//
// Every handler reports success AND failure on screen. Silent catch blocks are
// why the app previously looked like it had logged something when it had not.
//
// WATER IS DELIBERATELY NOT LIKE THE OTHER TWO. Sleep and gym are one fact per
// day, so serialising them behind `withBusy` is right. Water is a count, and
// running it through withBusy meant a burst of six taps logged ONE glass: five
// real drinks fell into `if (state.busy) return` and vanished without a word.
// The water button now updates the screen on the tap itself and batches the
// writes (see lib/water.mjs); nothing about it can be busy.

import {
  logHydrationBatch, fetchHydrationTotal, undoLastHydration,
  fetchWaterGoalMl, setWaterGoalMl,
  fetchOpenSleepSession, startSleepSession, endSleepSession, adjustSleepWake,
  logGymAnswer, fetchTodayGymAnswer,
} from "../services/supabase-data.js";
import {
  WATER_FLUSH_MS, WATER_GOAL_MAX_ML, WATER_TAP_ML,
  applyServerTotal, createWaterState, flushFailed, flushOk, fmtMl,
  setGoalMl, takeFlushBatch, tapWater, undoWater, waterView,
} from "../../lib/water.mjs";
import { showToast } from "./toast.js";

const HOST_ID = "quickActions";
// The long-press menu. The button itself is always one glass; these are the
// exceptions you reach for a few times a week, not the thing you do 12 times a day.
const WATER_MORE_STEPS = [500, 1000];
const LONG_PRESS_MS = 450;

let state = { sleep: null, gym: null, busy: false, water: createWaterState() };

function el(id) {
  return document.getElementById(id);
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

    ${waterRowHtml()}

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

// ---------------------------------------------------------------------------
// WATER
// ---------------------------------------------------------------------------

// The row must stay the SECOND child of #quickActions and must keep a .quick-note
// holding the total: scripts/smoke-ui.mjs reads
// `#quickActions .quick-row:nth-child(2) .quick-note` to prove a tap moved the
// number, and clicks `button[data-act="water"][data-ml="250"]` to do the tapping.
function waterRowHtml() {
  const v = waterView(state.water);
  return `
    <div class="quick-row quick-row-water" role="group" aria-label="Water">
      <span class="quick-label">Water</span>
      <button type="button" id="waterDrop" class="water-drop" data-act="water" data-ml="${WATER_TAP_ML}"
              style="--water-fill:${v.pct}%"
              aria-label="${waterDropLabel(v)}"
              title="Tap to add ${fmtMl(WATER_TAP_ML)}. Hold for other amounts.">
        <span class="water-drop-fill" aria-hidden="true"></span>
        <span class="water-drop-value" id="waterDropValue">${v.totalText}</span>
      </button>
      <button type="button" class="quick-btn quick-undo" data-act="water-undo" id="waterUndo"
              ${v.canUndo ? "" : "disabled"}
              aria-label="${v.canUndo ? "Undo the last water you logged" : "Nothing to undo - no water logged today"}"
              title="${v.canUndo ? "Undo the last glass" : "Nothing to undo yet"}">↺</button>
      <button type="button" class="quick-btn quick-water-more" data-act="water-more"
              aria-label="More water options: 500 ml, 1 litre, a custom amount, or change the daily goal"
              title="More amounts and the daily goal">⋯</button>
      <span class="quick-note" id="waterNote">
        <span class="quick-meter" aria-hidden="true"><span style="width:${v.pct}%"></span></span>
        <span id="waterNoteText" aria-live="polite">${waterNoteText(v)}</span>
      </span>
    </div>
  `;
}

function waterDropLabel(v) {
  return `Add ${fmtMl(WATER_TAP_ML)} of water. ${v.totalText} of ${v.goalText} today, ${v.pct} percent. Press and hold for other amounts.`;
}

// The meter caps at 100%, the TEXT never does: drinking 4.2L against a 3.5L goal
// reads "4.2L / 3.5L" with a full bar, not "3.5L / 3.5L".
function waterNoteText(v) {
  const unsaved = v.unsavedMl ? ` · saving ${fmtMl(v.unsavedMl)}` : "";
  return `${v.label}${unsaved}`;
}

// Repaint ONLY the water bits, in place.
//
// A tap must not blow away and rebuild the whole row: replacing innerHTML mid-burst
// destroys the button under the user's thumb (so the next tap lands on nothing),
// drops focus, and closes the long-press menu while they are reading it.
function paintWater() {
  const drop = el("waterDrop");
  if (!drop) return;
  const v = waterView(state.water);
  drop.style.setProperty("--water-fill", `${v.pct}%`);
  drop.setAttribute("aria-label", waterDropLabel(v));
  const value = el("waterDropValue");
  if (value) value.textContent = v.totalText;
  const noteText = el("waterNoteText");
  if (noteText) noteText.textContent = waterNoteText(v);
  const meter = el("waterNote")?.querySelector(".quick-meter > span");
  if (meter) meter.style.width = `${v.pct}%`;
  const undo = el("waterUndo");
  if (undo) {
    undo.toggleAttribute("disabled", !v.canUndo);
    undo.setAttribute("aria-label", v.canUndo ? "Undo the last water you logged" : "Nothing to undo - no water logged today");
    undo.setAttribute("title", v.canUndo ? "Undo the last glass" : "Nothing to undo yet");
  }
}

// THE TAP. Zero network, zero await, cannot be blocked. The screen moves on this
// frame and the write is owed to a debounced batch.
function onWaterTap(ml) {
  state.water = tapWater(state.water, ml);
  paintWater();
  scheduleWaterFlush();
}

// The write path is separated from the tap path on purpose. `_waterEpoch` counts
// server-side water changes we caused, so a read that was already in the air when
// we wrote can be recognised as stale and dropped instead of erasing the rows it
// could not have seen.
let _waterTimer = null;
let _waterFlush = null;
let _waterEpoch = 0;

function scheduleWaterFlush() {
  clearTimeout(_waterTimer);
  _waterTimer = setTimeout(() => { flushWaterNow(); }, WATER_FLUSH_MS);
}

// Send everything tapped since the last flush as ONE insert. Six taps in a burst
// cost one round trip, not six, and a seventh tap arriving mid-flush lands in the
// next batch rather than being lost.
async function flushWaterNow() {
  clearTimeout(_waterTimer);
  _waterTimer = null;
  if (_waterFlush) await _waterFlush.catch(() => {});
  const { next, batch } = takeFlushBatch(state.water);
  if (!batch.length) return;
  state.water = next;
  _waterFlush = (async () => {
    try {
      await logHydrationBatch(batch.map((t) => t.ml));
      state.water = flushOk(state.water, batch);
      _waterEpoch += 1;
      paintWater();
    } catch (err) {
      // Loudly, and with the number put back. A quick action that fails quietly
      // is worse than no button at all; an OPTIMISTIC one that fails quietly is
      // worse still, because the user watched the total go up before walking away.
      const rollback = flushFailed(state.water, batch);
      state.water = rollback.next;
      _waterEpoch += 1;
      paintWater();
      showToast(
        `Didn't save ${fmtMl(rollback.lostMl)} of water: ${err?.message || err}. The total has been put back - tap again.`,
        { kind: "error", duration: 6000 },
      );
      // Re-ground in whatever the server actually holds, in case part of the day
      // did land and only this batch did not.
      refreshQuickActions();
    } finally {
      _waterFlush = null;
    }
  })();
  await _waterFlush;
}

// The long-press / "⋯" menu: the amounts and the goal that do not deserve a
// permanent button.
function openWaterMore() {
  const host = el(HOST_ID);
  if (!host) return;
  if (el("waterMore")) { closeWaterMore(); return; }
  const v = waterView(state.water);

  const wrap = document.createElement("div");
  wrap.id = "waterMore";
  wrap.className = "water-more";
  wrap.innerHTML = `
    <p class="water-more-lead">Today: ${v.label}${v.over ? " (past the goal)" : ""}</p>
    <div class="water-more-row">
      ${WATER_MORE_STEPS.map((ml) => `
        <button type="button" class="quick-btn" data-act="water" data-ml="${ml}">+${fmtMl(ml)}</button>`).join("")}
      <input type="number" id="waterCustomMl" class="water-more-input" min="1" max="5000" step="50"
             inputmode="numeric" placeholder="ml" aria-label="Custom amount in millilitres" />
      <button type="button" class="quick-btn" data-act="water-custom">Add</button>
    </div>
    <div class="water-more-row">
      <label class="water-more-label" for="waterGoalInput">Daily goal</label>
      <input type="number" id="waterGoalInput" class="water-more-input" min="1" max="${WATER_GOAL_MAX_ML}" step="50"
             inputmode="numeric" value="${v.goalMl}" aria-label="Daily water goal in millilitres" />
      <button type="button" class="quick-btn" data-act="water-goal-save">Save goal</button>
      <button type="button" class="quick-btn water-more-close" data-act="water-more-close">Done</button>
    </div>
  `;
  // Deliberately NOT autofocused: focusing the custom-ml field throws up the
  // phone keyboard over the menu, and the common reason to open this is to tap
  // "+500", not to type.
  host.appendChild(wrap);
}

function closeWaterMore() {
  el("waterMore")?.remove();
}

// ---------------------------------------------------------------------------

// Re-read the facts from the server and repaint.
//
// EXPORTED because this row went stale the moment anything else logged the same
// fact: type "went to gym" into the capture box and the Gym button below still read
// "unanswered", so it got tapped again. That produced a real duplicate workout row
// on 2026-07-22. The page now calls this after every state change.
//
// Coalesced: a burst of state updates collapses into one round of reads.
let _inflight = null;
export function refreshQuickActions() {
  if (!el(HOST_ID)) return Promise.resolve();
  if (_inflight) return _inflight;
  _inflight = refresh().finally(() => { _inflight = null; });
  return _inflight;
}

async function refresh() {
  // Each read is independent - one failing must not blank the other three.
  const epoch = _waterEpoch;
  const [sleep, water, gym, goal] = await Promise.allSettled([
    fetchOpenSleepSession(),
    fetchHydrationTotal(new Date()),
    fetchTodayGymAnswer(new Date()),
    fetchWaterGoalMl(),
  ]);
  if (sleep.status === "fulfilled") state.sleep = sleep.value;
  if (gym.status === "fulfilled") state.gym = gym.value;
  // A goal the user never set reads as null; resolveGoalMl inside setGoalMl would
  // reject it, so fall through to the state's existing (scaffold-derived) goal.
  if (goal.status === "fulfilled" && goal.value != null) {
    state.water = setGoalMl(state.water, goal.value).next;
  }
  // Only trust a water reading that could actually have seen our writes. This
  // read was issued before `epoch` changed; if a flush or an undo landed while it
  // was in the air it is describing a database that no longer exists, and applying
  // it would erase rows the user watched us save. applyServerTotal drops it too if
  // a batch is still in flight.
  if (water.status === "fulfilled" && epoch === _waterEpoch) {
    state.water = applyServerTotal(state.water, { ml: water.value.ml, rows: water.value.rows });
  }
  const failed = [sleep, water, gym, goal].filter((r) => r.status === "rejected");
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

// Serialises the ONE-FACT-PER-DAY actions (sleep, gym, an undo that has to hit
// the server). Water taps deliberately do not come through here - see the header.
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

  // Long-press on the drop opens the menu. The flag stops the click that follows
  // the press from also logging a glass - otherwise every long-press would add
  // 250 ml the user did not drink.
  let pressTimer = null;
  let pressFired = false;
  host.addEventListener("pointerdown", (event) => {
    if (!event.target.closest('#waterDrop')) return;
    pressFired = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressFired = true; openWaterMore(); }, LONG_PRESS_MS);
  });
  const endPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  host.addEventListener("pointerup", endPress);
  host.addEventListener("pointercancel", endPress);
  host.addEventListener("pointerleave", endPress);
  // A long press is a gesture, not a text selection or an OS context menu.
  host.addEventListener("contextmenu", (event) => {
    if (event.target.closest("#waterDrop")) event.preventDefault();
  });

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
      if (pressFired) { pressFired = false; return; }   // this click belongs to a long press
      const ml = Number(btn.dataset.ml) || WATER_TAP_ML;
      onWaterTap(ml);
      if (el("waterMore") && btn.closest("#waterMore")) closeWaterMore();
      return;
    }

    if (act === "water-more") { openWaterMore(); return; }
    if (act === "water-more-close") { closeWaterMore(); return; }

    if (act === "water-custom") {
      const input = el("waterCustomMl");
      const ml = Math.round(Number(input?.value) || 0);
      if (!(ml > 0)) { showToast("Enter how many millilitres to add."); return; }
      onWaterTap(ml);
      showToast(`+${fmtMl(ml)} water.`);
      closeWaterMore();
      return;
    }

    if (act === "water-goal-save") {
      const input = el("waterGoalInput");
      const attempt = setGoalMl(state.water, input?.value);
      if (!attempt.ok) { showToast(attempt.reason, { kind: "error", duration: 5000 }); return; }
      btn.setAttribute("disabled", "");
      try {
        const saved = await setWaterGoalMl(attempt.ml);
        state.water = setGoalMl(state.water, saved).next;
        paintWater();
        showToast(attempt.clamped
          ? `Goal set to ${fmtMl(saved)} (capped at ${fmtMl(WATER_GOAL_MAX_ML)}).`
          : `Water goal set to ${fmtMl(saved)}.`);
        closeWaterMore();
      } catch (err) {
        showToast(`Couldn't save the goal: ${err?.message || err}`, { kind: "error", duration: 5000 });
      } finally {
        btn.removeAttribute("disabled");
      }
      return;
    }

    if (act === "water-undo") {
      const { next, undone } = undoWater(state.water);
      // Nothing to undo is SAID, not silently ignored. The control is already
      // disabled in this state; this covers a stale click that slips through.
      if (!undone) { showToast("Nothing to undo - no water logged today."); return; }
      if (undone.scope === "pending") {
        // The tap was never written, so there is no row to delete and, crucially,
        // no chance of deleting the older row that came before it.
        state.water = next;
        paintWater();
        showToast(`Removed ${fmtMl(undone.ml)} - it hadn't been saved yet.`);
        return;
      }
      await withBusy(btn, async () => {
        // Let any in-flight batch land first, so undo removes the newest row
        // instead of racing the insert that is creating it.
        await flushWaterNow();
        const removed = await undoLastHydration();
        _waterEpoch += 1;
        showToast(removed ? `Removed ${fmtMl(removed.ml)}.` : "Nothing to undo today.");
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

  // A tab switch or a backgrounded phone is exactly when an unflushed tap would
  // be lost, so pay the debt immediately rather than on a timer that may never fire.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWaterNow();
  });

  renderQuickActions();
  refresh();
}
