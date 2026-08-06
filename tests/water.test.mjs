import assert from "node:assert/strict";
import {
  WATER_GOAL_KIND, WATER_GOAL_SCAFFOLD_ML, WATER_GOAL_MAX_ML, WATER_TAP_ML,
  applyServerTotal, canUndo, clampGoalMl, createWaterState, flushFailed, flushOk,
  fmtMl, pctOf, resolveGoalMl, setGoalMl, takeFlushBatch, tapWater, totalMl,
  undoWater, waterView,
} from "../lib/water.mjs";

// --- fmtMl: the exact strings that go on screen -----------------------------
{
  assert.equal(fmtMl(250), "250ml");
  assert.equal(fmtMl(999), "999ml");
  assert.equal(fmtMl(1000), "1L", "a round litre must not read 1.0L");
  assert.equal(fmtMl(1250), "1.3L");
  assert.equal(fmtMl(1500), "1.5L");
  assert.equal(fmtMl(3450), "3.5L", "the scaffold goal as the row prints it");
  assert.equal(fmtMl(4200), "4.2L");
  assert.equal(fmtMl(10000), "10L");
  assert.equal(fmtMl(0), "0ml");
  // Garbage in must not put "NaNml" on a user's screen.
  assert.equal(fmtMl(undefined), "0ml");
  assert.equal(fmtMl(null), "0ml");
  assert.equal(fmtMl("nope"), "0ml");
}

// --- THE REAL BUG: six rapid taps are six drinks, not one -------------------
{
  let s = createWaterState({ serverMl: 0, serverRows: 0, goalMl: null });
  // Six taps with NOTHING awaited in between - this is what a burst of thumb
  // taps looks like, and the old `if (state.busy) return` ate five of them.
  for (let i = 0; i < 6; i += 1) s = tapWater(s, WATER_TAP_ML);
  assert.equal(totalMl(s), 1500, "6 x 250ml = 1500ml, optimistically, with zero network");
  assert.equal(s.pending.length, 6, "six taps must be six rows waiting to be written");

  // And they go to the server as ONE batch, not six round trips.
  const { next, batch } = takeFlushBatch(s);
  assert.equal(batch.length, 6);
  assert.equal(batch.reduce((sum, t) => sum + t.ml, 0), 1500);
  assert.equal(next.pending.length, 0, "a flush must empty pending so a second flush cannot resend");
  assert.equal(next.inflight.length, 6);
  assert.equal(totalMl(next), 1500, "moving pending -> inflight must not move the number on screen");

  // A second flush with nothing new pending sends nothing.
  const second = takeFlushBatch(next);
  assert.equal(second.batch.length, 0);
  assert.equal(second.next, next, "an empty flush must not churn state");

  const done = flushOk(next, batch);
  assert.equal(totalMl(done), 1500);
  assert.equal(done.inflight.length, 0);
  assert.equal(done.serverMl, 1500);
  assert.equal(done.serverRows, 6, "six hydration_logs rows, one per tap");
}

// Taps that arrive DURING a flush belong to the next batch, not to a limbo.
{
  let s = createWaterState({ goalMl: 3450 });
  s = tapWater(s, 250);
  s = tapWater(s, 250);
  const { next, batch } = takeFlushBatch(s);
  let mid = tapWater(next, 250);          // tapped while the first batch is in the air
  assert.equal(totalMl(mid), 750, "an in-flight batch still counts toward the total");
  mid = flushOk(mid, batch);
  assert.equal(totalMl(mid), 750);
  assert.equal(mid.pending.length, 1, "the tap made mid-flush is still owed to the server");
  const tail = takeFlushBatch(mid);
  assert.equal(tail.batch.length, 1);
  assert.equal(totalMl(flushOk(tail.next, tail.batch)), 750);
}

// --- a failed flush rolls the optimistic total back, visibly ----------------
{
  let s = createWaterState({ serverMl: 500, serverRows: 2, goalMl: 3450 });
  s = tapWater(s, 250);
  s = tapWater(s, 250);
  assert.equal(totalMl(s), 1000, "on screen immediately");
  const { next, batch } = takeFlushBatch(s);
  const { next: rolled, lostMl } = flushFailed(next, batch);
  assert.equal(lostMl, 500, "the caller has to be able to name what did not save");
  assert.equal(totalMl(rolled), 500, "the number must go BACK DOWN, not stay comfortably wrong");
  assert.equal(rolled.inflight.length, 0);
  assert.equal(rolled.serverMl, 500, "a failed flush must never touch confirmed rows");
}

// --- a pending tap cancelled by undo must not delete an older row -----------
{
  // Yesterday is not in this state at all, and today already has one real row.
  let s = createWaterState({ serverMl: 250, serverRows: 1, goalMl: 3450 });
  s = tapWater(s, 250);
  assert.equal(totalMl(s), 500);
  const { next, undone } = undoWater(s);
  assert.equal(undone.scope, "pending", "the newest tap has not been written; undo is local");
  assert.equal(undone.ml, 250);
  assert.equal(totalMl(next), 250, "back to the one confirmed row");
  assert.equal(next.serverMl, 250, "the OLDER, already-saved row must survive untouched");
  assert.equal(next.serverRows, 1, "no server delete may be issued for a tap that never left");
}

// Undo pops LIFO, newest first, and only reaches the server once the local
// stack is empty.
{
  let s = createWaterState({ serverMl: 1000, serverRows: 2, goalMl: 3450 });
  s = tapWater(s, 250);
  s = tapWater(s, 1000);
  const first = undoWater(s);
  assert.equal(first.undone.ml, 1000, "LIFO: the 1000 was tapped last");
  const second = undoWater(first.next);
  assert.equal(second.undone.ml, 250);
  assert.equal(totalMl(second.next), 1000);
  const third = undoWater(second.next);
  assert.equal(third.undone.scope, "server", "nothing local left, so ask the server which row is newest");
  assert.equal(third.undone.ml, null, "we do not know the row's size until the server answers");
  assert.equal(third.next, second.next, "state waits for the server before moving");
}

// --- undo on an empty day returns null; it cannot reach into yesterday ------
{
  // serverRows is seeded from a read already bounded to the LOCAL day, so a day
  // with nothing logged has nothing to offer undo - even if yesterday was full.
  const empty = createWaterState({ serverMl: 0, serverRows: 0, goalMl: 3450 });
  assert.equal(canUndo(empty), false);
  const { next, undone } = undoWater(empty);
  assert.equal(undone, null, "nothing to undo, said out loud, rather than a silent no-op");
  assert.equal(next, empty);

  // One tap makes it undoable again, and undoing it makes it un-undoable.
  const one = tapWater(empty, 250);
  assert.equal(canUndo(one), true);
  assert.equal(canUndo(undoWater(one).next), false);
}

// --- pctOf is finite for every hostile goal ---------------------------------
{
  assert.equal(pctOf(1500, 3000), 50);
  assert.equal(pctOf(0, 3450), 0);
  // The Infinity bug: Math.round(1500 / 0 * 100) used to render width:Infinity%.
  assert.equal(pctOf(1500, 0), 0);
  assert.equal(pctOf(1500, -1000), 0);
  assert.equal(pctOf(1500, null), 0);
  assert.equal(pctOf(1500, undefined), 0);
  assert.equal(pctOf(1500, NaN), 0);
  assert.equal(pctOf(1500, Infinity), 0);
  assert.equal(pctOf(NaN, 3450), 0);
  assert.equal(pctOf(1500, 1e12), 0);
  assert.equal(pctOf(-500, 3450), 0, "a negative total cannot draw a negative-width bar");
  for (const [t, g] of [[1500, 0], [0, 0], [NaN, NaN], [1e9, 1], [-1, -1]]) {
    assert.ok(Number.isFinite(pctOf(t, g)), `pctOf(${t}, ${g}) must be finite`);
  }
}

// --- over goal: the bar caps at 100, the text does not ----------------------
{
  let s = createWaterState({ serverMl: 4200, serverRows: 12, goalMl: 3450 });
  const v = waterView(s);
  assert.equal(v.pct, 100, "the meter cannot be more than full");
  assert.equal(v.over, true);
  assert.equal(v.label, "4.2L / 3.5L", "the real total stays on screen, uncapped");
  assert.equal(v.totalMl, 4200);
  assert.equal(v.totalText, "4.2L");
  assert.equal(v.goalText, "3.5L");
  // Exactly on goal is 100 too, but not "over".
  const exact = waterView(createWaterState({ serverMl: 3450, serverRows: 10, goalMl: 3450 }));
  assert.equal(exact.pct, 100);
  assert.equal(exact.over, false);
}

// --- goal clamping ----------------------------------------------------------
{
  assert.equal(clampGoalMl(4000), 4000);
  assert.equal(clampGoalMl("4000"), 4000);
  assert.equal(clampGoalMl(4000.4), 4000);
  // Rejected, NOT quietly turned into something usable.
  assert.equal(clampGoalMl(0), null, "0 is what made the meter Infinity");
  assert.equal(clampGoalMl(-1), null);
  assert.equal(clampGoalMl(-4000), null);
  assert.equal(clampGoalMl(0.4), null, "rounds to 0, so it is not a goal");
  assert.equal(clampGoalMl(NaN), null);
  assert.equal(clampGoalMl(Infinity), null);
  assert.equal(clampGoalMl(null), null);
  assert.equal(clampGoalMl(undefined), null);
  assert.equal(clampGoalMl(""), null);
  assert.equal(clampGoalMl("abc"), null);
  // Capped at the top: a typo'd 40000 becomes 10000, not a bar that never moves.
  assert.equal(clampGoalMl(40000), WATER_GOAL_MAX_ML);
  assert.equal(clampGoalMl(WATER_GOAL_MAX_ML), 10000);
  assert.equal(clampGoalMl(1), 1);
}

// resolveGoalMl always yields a positive finite number, falling back to the
// scaffold sum rather than to a second hardcoded 3000.
{
  assert.equal(WATER_GOAL_SCAFFOLD_ML, 3450, "the diet scaffold's own water schedule");
  assert.equal(WATER_GOAL_KIND, "daily_water_ml");
  assert.equal(resolveGoalMl(4000), 4000);
  assert.equal(resolveGoalMl(null), 3450);
  assert.equal(resolveGoalMl(0), 3450, "a stored 0 falls through to the scaffold");
  assert.equal(resolveGoalMl(-5, 4000), 4000);
  assert.equal(resolveGoalMl(undefined, null, 0), 3450);
  assert.equal(resolveGoalMl(99999), 10000);
  assert.ok(Number.isFinite(pctOf(1, resolveGoalMl(0))));
}

// setGoalMl reports rejection instead of storing a broken goal.
{
  const s = createWaterState({ serverMl: 1000, serverRows: 4, goalMl: 3450 });
  const ok = setGoalMl(s, 4000);
  assert.equal(ok.ok, true);
  assert.equal(ok.ml, 4000);
  assert.equal(ok.clamped, false);
  assert.equal(waterView(ok.next).label, "1L / 4L");

  const zero = setGoalMl(s, 0);
  assert.equal(zero.ok, false);
  assert.equal(zero.next, s, "a rejected goal must not touch the state");
  assert.ok(/between/.test(zero.reason), "the rejection has to say what is allowed");

  const huge = setGoalMl(s, 40000);
  assert.equal(huge.ok, true);
  assert.equal(huge.ml, 10000);
  assert.equal(huge.clamped, true, "a clamped goal is flagged so the user is told");

  // A state built with a poisoned goal still renders a finite meter.
  const poisoned = createWaterState({ serverMl: 500, serverRows: 2, goalMl: 0 });
  assert.equal(poisoned.goalMl, 3450);
  assert.ok(Number.isFinite(waterView(poisoned).pct));
}

// --- a server re-read must not double-count or erase an in-flight batch -----
{
  let s = createWaterState({ serverMl: 0, serverRows: 0, goalMl: 3450 });
  s = tapWater(s, 250);
  s = tapWater(s, 250);
  const { next, batch } = takeFlushBatch(s);
  // A refresh racing the insert: the read may or may not include these two rows,
  // and we cannot tell, so it is dropped rather than guessed at.
  const raced = applyServerTotal(next, { ml: 500, rows: 2 });
  assert.equal(raced, next, "a reading taken mid-flight is stale by construction");
  assert.equal(totalMl(raced), 500, "not 1000");

  const settled = flushOk(next, batch, { ml: 500, rows: [{ id: "a" }, { id: "b" }] });
  assert.equal(totalMl(settled), 500);
  assert.equal(settled.serverRows, 2, "rows may arrive as an array or a count");

  // Once nothing is in flight, a fresh read wins, and pending taps stack on top
  // because they are not on the server yet by definition.
  let after = tapWater(settled, 250);
  after = applyServerTotal(after, { ml: 750, rows: 3 });   // another device logged one
  assert.equal(after.serverMl, 750);
  assert.equal(totalMl(after), 1000, "server truth + the tap we still owe");
}

// --- a 0 ml tap is a caller bug, not a drink --------------------------------
{
  const s = createWaterState({ goalMl: 3450 });
  assert.equal(tapWater(s, 0), s);
  assert.equal(tapWater(s, -250), s);
  assert.equal(tapWater(s, NaN), s);
  assert.equal(tapWater(s, "250").pending[0].ml, 250, "a dataset attribute arrives as a string");
  assert.equal(tapWater(s).pending[0].ml, WATER_TAP_ML, "the default tap is one glass");
}

console.log("water tests passed");
