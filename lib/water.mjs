// The water quick-action's brain: an OPTIMISTIC tap reducer plus the goal math.
//
// THE INCIDENT THIS EXISTS FOR: the old row awaited a server insert AND a full
// three-table refresh inside a `if (state.busy) return` guard, so tapping the
// +250 button six times in three seconds logged ONE glass. Five real drinks were
// silently discarded by a guard whose only job was to stop double-submits. The
// owner's requirement is the exact opposite: "if it is pressed multiple times,
// that means people had more water."
//
// So a tap is a pure state transition with zero network in it. Taps accumulate
// in `pending`, the caller flushes them as ONE batched insert a beat after the
// last tap, and the displayed total moves on the very first frame. Nothing here
// can drop a tap because nothing here can be busy.
//
// Three states a tap can be in, and the difference matters:
//   pending  - tapped, not yet sent. Undo pops it locally, no network, and the
//              row it would have written never exists.
//   inflight - sent, waiting on the server. Still counted in the total, but a
//              server reading taken now is stale BY CONSTRUCTION and is ignored.
//   server   - confirmed rows. Undo here has to ask the server which row it is.
//
// Pure: no DOM, no Supabase, no clock. Every function returns a NEW state so a
// render can diff it, and every branch is unit-testable (tests/water.test.mjs).

import { WATER } from "./diet-scaffold.mjs";

// The `budgets.kind` that stores an explicit goal. One string, shared by the
// service that reads/writes it and the UI that edits it, so a typo cannot make
// the read and the write disagree about which row is the goal.
export const WATER_GOAL_KIND = "daily_water_ml";

// The fallback goal is the diet scaffold's own water schedule summed up (3450),
// NOT a second hardcoded 3000. Those were two different numbers on one screen
// once; deriving it means there is exactly one and it cannot drift again.
export const WATER_GOAL_SCAFFOLD_ML = WATER.reduce((sum, w) => sum + w.ml, 0);

// A goal of 0 made the meter `Math.round(x / 0 * 100)` = Infinity, which renders
// as `width:Infinity%`. Reject it at the door. 10 L/day is already past the point
// where water is a medical problem, so anything above it is a typo (someone
// meaning 4000 and typing 40000), not an ambition.
export const WATER_GOAL_MIN_ML = 1;
export const WATER_GOAL_MAX_ML = 10000;

// One tap = one glass. The button is hardcoded to this; everything else is the
// long-press menu.
export const WATER_TAP_ML = 250;

// How long after the LAST tap we send the batch. Long enough that a six-tap
// burst is one insert, short enough that walking away right after tapping still
// saves. Re-armed on every tap, never on a timer of its own.
export const WATER_FLUSH_MS = 800;

// "250ml" / "1L" / "1.5L" / "3.5L". Sub-litre stays in ml because "0.3L" is not
// how anyone says a glass of water. The trailing ".0" is stripped so a round
// 10000 reads "10L" and not "10.0L".
export function fmtMl(ml) {
  const n = Math.round(Number(ml) || 0);
  if (Math.abs(n) < 1000) return `${n}ml`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}L`;
}

// A usable goal in ml, or null if the input is not one. Null means "refuse and
// tell the user", never "quietly use 0".
export function clampGoalMl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ml = Math.round(n);
  if (ml < WATER_GOAL_MIN_ML) return null;       // 0 and negatives are rejected, not clamped up
  return Math.min(ml, WATER_GOAL_MAX_ML);
}

// The goal to actually use: the first candidate that survives clamping, else the
// scaffold sum. Callers pass (rowFromBudgets, whateverElse) and always get a
// positive finite number back, which is what makes pctOf safe.
export function resolveGoalMl(...candidates) {
  for (const c of candidates) {
    const ml = clampGoalMl(c);
    if (ml !== null) return ml;
  }
  return WATER_GOAL_SCAFFOLD_ML;
}

// Percent of goal for the METER only: 0..100, always an integer, never NaN or
// Infinity whatever the inputs. Over-goal caps here on purpose - the bar cannot
// be more than full - but the TEXT beside it keeps showing the real total, so
// drinking 4.2 L against a 3.5 L goal reads "4.2L / 3.5L" with a full bar.
export function pctOf(total, goal) {
  const t = Number(total);
  const g = Number(goal);
  if (!Number.isFinite(t) || !Number.isFinite(g) || g <= 0) return 0;
  const pct = Math.round((t / g) * 100);
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

function sumMl(taps) {
  return taps.reduce((sum, t) => sum + t.ml, 0);
}

// `rows` may arrive as the array fetchHydrationTotal returns or as a count.
function rowCount(rows) {
  if (Array.isArray(rows)) return rows.length;
  const n = Number(rows);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// serverMl/serverRows describe TODAY only - they are seeded from a read that is
// already bounded to the local day, which is what keeps undo out of yesterday.
export function createWaterState({ serverMl = 0, serverRows = 0, goalMl = null } = {}) {
  return {
    serverMl: Math.max(0, Math.round(Number(serverMl) || 0)),
    serverRows: rowCount(serverRows),
    goalMl: resolveGoalMl(goalMl),
    pending: [],
    inflight: [],
    seq: 0,   // a counter, not a clock: ids must be stable and pure
  };
}

// What the row shows right now = confirmed + everything we have promised.
export function totalMl(state) {
  return state.serverMl + sumMl(state.pending) + sumMl(state.inflight);
}

export function canUndo(state) {
  return state.pending.length > 0 || state.inflight.length > 0 || state.serverRows > 0;
}

// THE TAP. No await, no busy check, no way to fail. Six of these in a row are
// six drinks.
export function tapWater(state, ml = WATER_TAP_ML) {
  const amount = Math.round(Number(ml) || 0);
  if (!(amount > 0)) return state;   // a 0 ml tap is a bug in the caller, not a drink
  const seq = state.seq + 1;
  return { ...state, seq, pending: [...state.pending, { id: seq, ml: amount }] };
}

// Hand the pending taps to the caller to send, and move them to `inflight` in
// the same step so a second flush cannot send them twice. The total does not
// move: they were already counted while pending.
export function takeFlushBatch(state) {
  if (!state.pending.length) return { next: state, batch: [] };
  const batch = state.pending;
  return { next: { ...state, pending: [], inflight: [...state.inflight, ...batch] }, batch };
}

// The batch landed. Promote it from optimistic to confirmed. `serverTotal` is
// the optional authoritative re-read; without it we add the batch ourselves,
// which is exact because every tap wrote exactly one row.
export function flushOk(state, batch, serverTotal = null) {
  const ids = new Set(batch.map((t) => t.id));
  const next = {
    ...state,
    inflight: state.inflight.filter((t) => !ids.has(t.id)),
    serverMl: state.serverMl + sumMl(batch),
    serverRows: state.serverRows + batch.length,
  };
  return serverTotal ? applyServerTotal(next, serverTotal) : next;
}

// The batch did NOT land. Drop it out of the total so the number on screen goes
// visibly BACK DOWN. `lostMl` is handed to the caller to say so out loud - a
// quick action that fails quietly is worse than no button at all, and an
// optimistic one that fails quietly is worse still, because the user watched it
// work.
export function flushFailed(state, batch) {
  const ids = new Set(batch.map((t) => t.id));
  return {
    next: { ...state, inflight: state.inflight.filter((t) => !ids.has(t.id)) },
    lostMl: sumMl(batch),
  };
}

// Fold in a fresh server read.
//
// IGNORED while anything is inflight: that read either includes the inflight
// rows or does not, we cannot tell which, and guessing wrong either double-counts
// the batch or erases it. Pending taps are not on the server by definition, so
// they simply stay stacked on top of whatever the server says.
export function applyServerTotal(state, { ml = 0, rows = 0 } = {}) {
  if (state.inflight.length) return state;
  return {
    ...state,
    serverMl: Math.max(0, Math.round(Number(ml) || 0)),
    serverRows: rowCount(rows),
  };
}

// Undo pops LIFO, and WHERE it pops from is the whole point:
//   - a pending tap is cancelled locally. It never reaches the server, so it
//     cannot delete the older row that a naive "delete the newest row" undo
//     would have hit instead.
//   - with nothing pending, the caller has to ask the server which row is newest
//     (we do not know its id or ml here), and that server call is bounded to
//     today.
//   - with nothing anywhere, `undone` is null: the control says "nothing to
//     undo" and is disabled, rather than silently doing nothing.
export function undoWater(state) {
  if (state.pending.length) {
    const removed = state.pending[state.pending.length - 1];
    return {
      next: { ...state, pending: state.pending.slice(0, -1) },
      undone: { scope: "pending", ml: removed.ml },
    };
  }
  if (state.inflight.length || state.serverRows > 0) {
    return { next: state, undone: { scope: "server", ml: null } };
  }
  return { next: state, undone: null };
}

// Set the goal. Rejects rather than storing something that breaks the meter.
export function setGoalMl(state, value) {
  const ml = clampGoalMl(value);
  if (ml === null) {
    return { next: state, ok: false, ml: null, reason: `Water goal must be between ${WATER_GOAL_MIN_ML} and ${WATER_GOAL_MAX_ML} ml.` };
  }
  const asked = Math.round(Number(value));
  return { next: { ...state, goalMl: ml }, ok: true, ml, clamped: asked !== ml, reason: null };
}

// Everything the row needs to render, computed once so the button, the meter and
// the label can never disagree with each other.
export function waterView(state) {
  const total = totalMl(state);
  const goal = state.goalMl;
  return {
    totalMl: total,
    goalMl: goal,
    pct: pctOf(total, goal),          // meter: capped at 100
    totalText: fmtMl(total),          // text: the REAL total, uncapped
    goalText: fmtMl(goal),
    label: `${fmtMl(total)} / ${fmtMl(goal)}`,
    over: total > goal,
    canUndo: canUndo(state),
    unsavedMl: sumMl(state.pending) + sumMl(state.inflight),
  };
}

export default {
  WATER_GOAL_KIND, WATER_GOAL_SCAFFOLD_ML, WATER_GOAL_MIN_ML, WATER_GOAL_MAX_ML,
  WATER_TAP_ML, WATER_FLUSH_MS,
  fmtMl, clampGoalMl, resolveGoalMl, pctOf,
  createWaterState, totalMl, canUndo, tapWater, takeFlushBatch,
  flushOk, flushFailed, applyServerTotal, undoWater, setGoalMl, waterView,
};
