// AGENT TASKS - the governance a self-triggering agent runs under.
//
// This test exists because of one number: AUTO_APPLY_MIN_CONFIDENCE = 0. Every
// tool call the agent function emits commits immediately. That is defensible
// when a human just typed the capture and is watching the feed; at 03:00, with a
// model deciding on its own what to emit, it is not. So every refusal below is
// asserted, and the constants are compared against the jarvis edge function's
// own copy - the same anti-drift trick tests/mirror-parity.test.mjs uses for the
// lexicons, because a limit that exists only in lib/ governs nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTONOMOUS_TOOLS, TASK_INTENTS, AUTONOMY_LIMITS,
  autonomyAllowed, gateAutonomousRun, autonomyBudget, filterAutonomousActions,
  actionHash, countLoopHits, slotKeyFor, nextFireAt, buildTask, runOutcome,
} from "../lib/agent-tasks.mjs";

const edge = readFileSync("supabase/functions/jarvis/index.ts", "utf8");

// ---------------------------------------------------------------------------
// 1. the constants govern the SERVER, so they must match the server's copy
// ---------------------------------------------------------------------------
function edgeArray(name) {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(edge);
  assert.ok(m, `${name} not found in the jarvis edge function`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}
function edgeNumber(name) {
  const m = new RegExp(`const ${name} = ([0-9.]+)`).exec(edge);
  assert.ok(m, `${name} not found in the jarvis edge function`);
  return Number(m[1]);
}

assert.deepEqual(edgeArray("AUTONOMOUS_TOOLS"), AUTONOMOUS_TOOLS,
  "DRIFT: the edge function's autonomous allowlist and lib/agent-tasks.mjs disagree");
assert.deepEqual(edgeArray("TASK_INTENTS"), TASK_INTENTS, "DRIFT in TASK_INTENTS");
assert.equal(edgeNumber("AUTONOMY_MAX_DEPTH"), AUTONOMY_LIMITS.maxDepth);
assert.equal(edgeNumber("AUTONOMY_RATE_WINDOW_MIN"), AUTONOMY_LIMITS.rateWindowMin);
assert.equal(edgeNumber("AUTONOMY_RATE_MAX"), AUTONOMY_LIMITS.rateMax);
assert.equal(edgeNumber("AUTONOMY_DAILY_COST_USD"), AUTONOMY_LIMITS.dailyCostUsd);
assert.equal(edgeNumber("AUTONOMY_MAX_FAILURES"), AUTONOMY_LIMITS.maxFailures);
assert.equal(edgeNumber("AUTONOMY_LOOP_REPEATS"), AUTONOMY_LIMITS.loopRepeats);
assert.equal(edgeNumber("AUTONOMY_LOOP_WINDOW_H"), AUTONOMY_LIMITS.loopWindowH);
assert.equal(edgeNumber("AUTONOMY_MAX_PER_TICK"), AUTONOMY_LIMITS.maxPerTick);

// The allowlist is defined by what is NOT on it. Naming them individually so
// adding a write tool to the autonomous set has to be a deliberate edit here.
for (const forbidden of [
  "create_expense_candidate", "create_food_log_candidate", "create_workout_candidate",
  "update_plan_candidate", "set_target_candidate", "remember_fact",
  "delete_row", "merge_duplicate", "create_reminder_candidate",
]) {
  assert.ok(!AUTONOMOUS_TOOLS.includes(forbidden),
    `${forbidden} must never be autonomous: it commits at confidence 0 with nobody watching`);
}

// The budgets have to be MEANINGFULLY tighter than the human's, not nominally.
// The agent fn's limits are 60 calls / 5 min and $2/day.
assert.ok(AUTONOMY_LIMITS.rateMax <= 60 / 5, "the autonomy rate cap must be far under the human's 60/5min");
assert.ok(AUTONOMY_LIMITS.dailyCostUsd <= 2 / 4, "the autonomy cost cap must be far under the human's $2/day");

// And they must be on a SEPARATE ledger, or "separate budget" is a fiction.
// The task runner reads agent_task_runs; it must never write ai_runs.
{
  const runner = edge.slice(edge.indexOf("async function taskModel"), edge.indexOf("async function runStatus"));
  assert.ok(!/from\("ai_runs"\)/.test(runner),
    "an autonomous run must not touch ai_runs - that table is what the agent function's rate limiter and daily cap read");
  assert.ok(/from\("agent_task_runs"\)/.test(edge), "autonomous spend has to be accounted somewhere");
}

// ---------------------------------------------------------------------------
// 2. autonomy_enabled: read FIRST, and FAILING CLOSED
// ---------------------------------------------------------------------------
assert.equal(autonomyAllowed({ autonomy_enabled: true }).allowed, true);
assert.equal(autonomyAllowed({ autonomy_enabled: false }).allowed, false);
// The three shapes of "the read did not work". None of them is permission.
assert.equal(autonomyAllowed(null).allowed, false, "an unreadable flag must never read as permission");
assert.equal(autonomyAllowed(undefined).allowed, false);
assert.equal(autonomyAllowed({}).allowed, false, "a column that was not selected is not a yes");
assert.equal(autonomyAllowed({ autonomy_enabled: "true" }).allowed, false, "only the boolean true counts");
assert.equal(autonomyAllowed({ autonomy_enabled: 1 }).allowed, false);
assert.equal(autonomyAllowed(null).reason, "autonomy_flag_unreadable");

// And it is checked BEFORE anything else, so a disabled profile cannot be
// bypassed by a task that happens to look fine on every other axis.
{
  const g = gateAutonomousRun({
    profile: null,
    task: { intent: "check", depth: 0, consecutive_failures: 0 },
    runsInWindow: 0, todayCostUsd: 0, loopHits: 0,
  });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "autonomy_flag_unreadable");
}

// ---------------------------------------------------------------------------
// 3. the rest of the gate
// ---------------------------------------------------------------------------
const okProfile = { autonomy_enabled: true };
const base = { profile: okProfile, task: { intent: "check", depth: 0, consecutive_failures: 0 }, runsInWindow: 0, todayCostUsd: 0, loopHits: 0 };

assert.equal(gateAutonomousRun(base).allowed, true);

// A task may not create a task.
assert.deepEqual(
  pick(gateAutonomousRun({ ...base, task: { ...base.task, depth: 2 } })),
  { allowed: false, reason: "depth_cap", disable: true },
);
// Three consecutive failures trips a VISIBLE breaker.
assert.deepEqual(
  pick(gateAutonomousRun({ ...base, task: { ...base.task, consecutive_failures: 3 } })),
  { allowed: false, reason: "circuit_breaker", disable: true },
);
// The same actions three times in a day is a loop, not a schedule.
assert.deepEqual(
  pick(gateAutonomousRun({ ...base, loopHits: 3 })),
  { allowed: false, reason: "action_loop", disable: true },
);
// Budgets DELAY, they do not disable - a task that hit today's cap is fine tomorrow.
assert.deepEqual(
  pick(gateAutonomousRun({ ...base, runsInWindow: 6 })),
  { allowed: false, reason: "autonomy_rate_limited", disable: false },
);
assert.deepEqual(
  pick(gateAutonomousRun({ ...base, todayCostUsd: 0.25 })),
  { allowed: false, reason: "autonomy_cost_cap", disable: false },
);
// An unreadable ledger reads as exhausted, not as unlimited.
assert.equal(gateAutonomousRun({ ...base, runsInWindow: Infinity }).allowed, false);
assert.equal(gateAutonomousRun({ ...base, todayCostUsd: Infinity }).allowed, false);
// An unknown intent is a broken task, not a task to run anyway.
assert.equal(gateAutonomousRun({ ...base, task: { ...base.task, intent: "exfiltrate" } }).disable, true);

function pick(g) { return { allowed: g.allowed, reason: g.reason, disable: g.disable }; }

// A per-profile budget override is bounded on both ends.
assert.equal(autonomyBudget({}), AUTONOMY_LIMITS.dailyCostUsd);
assert.equal(autonomyBudget({ autonomy_daily_cost_usd: 0.5 }), 0.5);
assert.equal(autonomyBudget({ autonomy_daily_cost_usd: 999 }), 2, "a bad row cannot become unbounded spend");
assert.equal(autonomyBudget({ autonomy_daily_cost_usd: -1 }), AUTONOMY_LIMITS.dailyCostUsd);

// ---------------------------------------------------------------------------
// 4. the action filter
// ---------------------------------------------------------------------------
{
  const calls = [
    { name: "answer_question", arguments: { answer: "You are 40g short." } },
    { name: "create_expense_candidate", arguments: { amount: 250 } },
    { name: "set_target_candidate", arguments: { kind: "daily_protein", amount: 40 } },
    { name: "create_note_candidate", arguments: { body: "check the gym plan" } },
    { name: "schedule_agent_task", arguments: { prompt: "check again in an hour" } },
    { name: "", arguments: {} },
  ];
  const { allowed, blocked } = filterAutonomousActions(calls, 0);
  assert.deepEqual(allowed.map((c) => c.name), ["answer_question", "create_note_candidate"]);
  assert.deepEqual(blocked.map((b) => b.reason),
    ["not_autonomous", "not_autonomous", "not_autonomous", "unnamed_tool"]);
  // Blocked calls are RETURNED, never dropped: an autonomous run that wanted to
  // change a budget is exactly what a human should get to see afterwards.
  assert.equal(blocked.length, 4);
}
{
  // At depth, even the scheduling tool's rejection reason changes - so the log
  // says WHY, rather than a generic refusal.
  const { blocked } = filterAutonomousActions([{ name: "schedule_agent_task", arguments: {} }], 1);
  assert.equal(blocked[0].reason, "depth_cap");
}

// ---------------------------------------------------------------------------
// 5. the loop fingerprint
// ---------------------------------------------------------------------------
{
  const a = [{ name: "answer_question", arguments: { answer: "x", basis: "y" } }];
  const b = [{ name: "answer_question", arguments: { basis: "y", answer: "x" } }]; // key order
  assert.equal(actionHash(a), actionHash(b), "key order must not change the fingerprint");
  assert.notEqual(actionHash(a), actionHash([{ name: "answer_question", arguments: { answer: "z" } }]));
  assert.equal(actionHash([]), actionHash([]));
  // Order of the calls themselves must not matter either.
  const two = [{ name: "answer_question", arguments: {} }, { name: "create_note_candidate", arguments: {} }];
  assert.equal(actionHash(two), actionHash([...two].reverse()));
  assert.match(actionHash(a), /^[0-9a-f]{8}$/);

  const now = Date.parse("2026-08-06T12:00:00Z");
  const runs = [
    { action_hash: actionHash(a), started_at: "2026-08-06T11:00:00Z" },
    { action_hash: actionHash(a), started_at: "2026-08-06T09:00:00Z" },
    { action_hash: actionHash(a), started_at: "2026-08-04T09:00:00Z" }, // outside 24h
    { action_hash: "deadbeef", started_at: "2026-08-06T10:00:00Z" },
  ];
  assert.equal(countLoopHits(runs, actionHash(a), now), 2, "only hits inside the window count");
  assert.equal(countLoopHits(runs, "", now), 0);
}

// ---------------------------------------------------------------------------
// 6. slot keys and re-arming
// ---------------------------------------------------------------------------
{
  // A one-shot keys on its fire_at MINUTE, never on its id alone - a re-armed
  // task has to be able to fire again.
  const one = { fire_at: "2026-08-06T13:00:00.000Z", tz: "Asia/Kolkata", recurrence: null };
  assert.equal(slotKeyFor(one), "2026-08-06T18:30", "13:00Z is 18:30 IST");

  // A recurring task keys on its OCCURRENCE, so a retry collides.
  const rec = {
    fire_at: "2026-08-06T13:00:00.000Z", tz: "Asia/Kolkata",
    recurrence: { freq: "daily", at_time: "18:30" },
  };
  assert.equal(slotKeyFor(rec), "2026-08-06T18:30");
  assert.equal(slotKeyFor(rec, "2026-08-07T13:00:00.000Z"), "2026-08-07T18:30",
    "a different day is a different occupancy, so it fires again");
  assert.equal(slotKeyFor({ fire_at: "nonsense" }), null);
}
{
  // Re-arming: daily at 18:30 IST advances exactly one day.
  const task = { tz: "Asia/Kolkata", recurrence: { freq: "daily", at_time: "18:30" } };
  const after = Date.parse("2026-08-06T13:00:00Z");
  assert.equal(nextFireAt(task, after), "2026-08-07T13:00:00.000Z");

  // Weekly on Wednesdays, asked on the Wednesday it just fired.
  const weekly = { tz: "Asia/Kolkata", recurrence: { freq: "weekly", weekday: 3, at_time: "09:00" } };
  assert.equal(nextFireAt(weekly, Date.parse("2026-08-05T03:30:00Z")), "2026-08-12T03:30:00.000Z");

  // A one-shot never re-arms.
  assert.equal(nextFireAt({ recurrence: null }, after), null);
  // Neither does a rule past its UNTIL - the series is genuinely over.
  assert.equal(nextFireAt({ tz: "Asia/Kolkata", recurrence: { freq: "daily", at_time: "09:00", dtstart: "2026-08-01", until: "2026-08-05" } }, after), null);
  // Nor an unusable rule: a task that re-arms onto a date that does not exist
  // would be a task that quietly stops, which is the failure this codebase keeps
  // rediscovering.
  assert.equal(nextFireAt({ recurrence: { freq: "weekly", interval: 2 } }, after), null);
}

// ---------------------------------------------------------------------------
// 7. building a task
// ---------------------------------------------------------------------------
{
  const { task } = buildTask({
    prompt: "check my protein pace", intent: "check", tz: "Asia/Kolkata",
    recurrence: { freq: "daily", at_time: "16:00" }, nowMs: Date.parse("2026-08-06T05:00:00Z"),
  });
  assert.equal(task.fire_at, "2026-08-06T10:30:00.000Z", "16:00 IST today");
  assert.equal(task.intent, "check");
  assert.equal(task.depth, 0);
  assert.equal(task.created_by, "user");
}
// Every way a task can be un-runnable is an ERROR, never a half-built row: a
// task with a missing fire_at is one that silently never runs.
assert.match(buildTask({ prompt: "" }).error, /needs something to do/);
assert.match(buildTask({ prompt: "x" }).error, /needs a time to fire/);
assert.match(buildTask({ prompt: "x", recurrence: { freq: "weekly", interval: 2 } }).error, /recurrence:/);
assert.match(buildTask({ prompt: "x", fire_at: "not-a-time" }).error, /not a timestamp/);
assert.match(buildTask({ prompt: "x", fire_at: "2026-08-06T10:00:00Z", depth: 2 }).error, /may not create a task/);
// An unknown intent falls back to the safest one rather than being stored.
assert.equal(buildTask({ prompt: "x", fire_at: "2026-08-06T10:00:00Z", intent: "delete_everything" }).task.intent, "check");
// created_by is not free text either.
assert.equal(buildTask({ prompt: "x", fire_at: "2026-08-06T10:00:00Z", created_by: "root" }).task.created_by, "user");

// ---------------------------------------------------------------------------
// 8. silence is a logged outcome
// ---------------------------------------------------------------------------
assert.deepEqual(runOutcome({ spoke: false }), { status: "silent", result: "silent: on track", actions: 0 });
assert.equal(runOutcome({ spoke: true, actions: [1, 2], note: "said something" }).status, "spoke");
assert.equal(runOutcome({ error: "model 500" }).status, "failed");
assert.equal(runOutcome({ blocked: [{ reason: "not_autonomous" }] }).status, "blocked");
// A run that emitted nothing still reports how many actions it considered.
assert.equal(runOutcome({ spoke: false, actions: [] }).actions, 0);

// ---------------------------------------------------------------------------
// 9. the runner claims its row BEFORE the model call
// ---------------------------------------------------------------------------
// Asserted from the source: a crash between "claimed" and the model returning
// has to be distinguishable from "never ran", and that is only true if the
// insert precedes the call.
{
  const fn = edge.slice(edge.indexOf("async function executeTask"), edge.indexOf("async function runTask"));
  const claimAt = fn.indexOf('from("agent_task_runs")');
  const modelAt = fn.indexOf("taskModel(");
  assert.ok(claimAt !== -1 && modelAt !== -1, "executeTask must both claim a run row and call the model");
  assert.ok(claimAt < modelAt, "the run row must be claimed BEFORE the model call, or a crash looks like 'never ran'");
  assert.ok(/duplicate key\|unique/.test(fn), "a unique violation on the claim is a successful no-op, not an error");
  assert.ok(/status: "silent"/.test(fn), "a run that finds nothing must still write a row saying so");
}
// And the claim query itself must be `<=`, never `=`: a minute the scheduler
// missed has to still fire, late, rather than be skipped forever.
{
  const sql = readFileSync("supabase/migrations/20260806000030_calendar_engine.sql", "utf8");
  assert.match(sql, /fire_at <= now\(\)/, "claim by <=, never =");
  assert.match(sql, /for update skip locked/, "two schedulers must take different rows, not the same one");
  assert.ok(!/fire_at = now\(\)/.test(sql));
}

console.log("agent-tasks tests passed: allowlist, fail-closed autonomy flag, budgets, loop detector, re-arming");
