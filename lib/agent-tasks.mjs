// AGENT TASKS - the governance layer for an agent that wakes itself up.
//
// The requirement, in the owner's words: "when the scheduled task, it has to
// trigger on its own and wake up." That is the genuinely new thing here - the
// four fixed jarvis slots are a clock, this is an agenda.
//
// It is also the one part of this app where the existing safety story does not
// hold. `AUTO_APPLY_MIN_CONFIDENCE = 0` in the agent function means every tool
// call commits immediately; that is a defensible trade when a human just typed
// the capture and is watching the feed. At 03:00, with a model deciding on its
// own what to emit, it is not. So everything below is a REFUSAL surface:
//
//   * a NARROW allowlist - nothing that edits a plan, a target, a memory fact,
//     deletes anything, or reaches outside the app;
//   * a SEPARATE, lower rate and cost budget, accounted in agent_task_runs and
//     never in ai_runs, so a self-rescheduling loop cannot spend the human's
//     60-calls-per-5-minutes or their $2/day and lock them out of their own app;
//   * a depth cap - a task may not create a task;
//   * a loop detector - the same (task, action_hash) three times in 24h;
//   * a visible circuit breaker at three consecutive failures;
//   * autonomy_enabled read SERVER-SIDE, FIRST, and failing CLOSED.
//
// Pure: no DOM, no Supabase, no clock read except the `now` you pass in. The
// jarvis edge function hosts its own copy of the constants (Deno cannot import
// repo-relative lib/); tests/agent-tasks.test.mjs extracts them from the edge
// source and asserts they match this file, the same anti-drift trick
// tests/mirror-parity.test.mjs uses for the lexicons.

import { nextOccurrence, occurrenceKey, minutesOfDay, ruleProblem } from "./reminders.mjs";
import { instantAtLocal, dayKeyInTz, DEFAULT_TZ } from "./tz.mjs";

// ---------------------------------------------------------------------------
// the allowlist
// ---------------------------------------------------------------------------

// What an AUTONOMOUS run may emit. Read this list as everything it may NOT do:
// no create_expense_candidate, no update_plan_candidate, no set_target_candidate,
// no remember_fact, no delete of any kind, nothing that sends mail on its own.
// The three that remain are all reversible and all end up in front of the user.
export const AUTONOMOUS_TOOLS = ["answer_question", "create_note_candidate", "request_user_review"];

// What a task may be scheduled to DO. `remind` never involves a model at all.
export const TASK_INTENTS = ["check", "answer", "remind", "review"];

export const AUTONOMY_LIMITS = {
  // A task at depth >= maxDepth may not schedule another task. Depth 0 is
  // human-scheduled; 1 is one an agent run created. There is no level 2.
  maxDepth: 1,
  // Deliberately ~10x tighter than the human's 60/5min, and counted on its own
  // ledger (agent_task_runs) so the two cannot compete.
  rateWindowMin: 5,
  rateMax: 6,
  // Deliberately 8x tighter than DAILY_COST_CAP_USD, and likewise separate.
  dailyCostUsd: 0.25,
  // Three consecutive failures trips a VISIBLE breaker: status='disabled' with a
  // reason the user can read, not a silent retry every minute forever.
  maxFailures: 3,
  // The same actions three times inside a day is a loop, not a schedule.
  loopRepeats: 3,
  loopWindowH: 24,
  // How many tasks one tick may claim, so a backlog drains over minutes rather
  // than firing forty pushes at once.
  maxPerTick: 5,
};

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

/**
 * Is autonomy permitted for this profile at all?
 *
 * FAILS CLOSED, and that is the whole design: `profile` is null when the read
 * ERRORED or the row is missing, and both mean no. `!== true` rather than
 * `=== false` because an undefined flag - a column that was not selected, a
 * PostgREST schema cache that has not reloaded - is not permission either.
 * Everywhere else in this codebase a failed read must be surfaced rather than
 * swallowed; this is the one read that must ALSO be treated as "no".
 */
export function autonomyAllowed(profile) {
  if (!profile || typeof profile !== "object") {
    return { allowed: false, reason: "autonomy_flag_unreadable" };
  }
  if (profile.autonomy_enabled !== true) return { allowed: false, reason: "autonomy_disabled" };
  return { allowed: true, reason: "" };
}

/**
 * Everything checked before a task is allowed to think, in the order that costs
 * least. `disable` means the task itself should be switched off, not just
 * skipped - the caller writes the reason onto agent_tasks.disabled_reason so it
 * is visible instead of being a task that mysteriously stopped.
 *
 * ctx: { profile, task, runsInWindow, todayCostUsd, loopHits }
 */
export function gateAutonomousRun(ctx) {
  const c = ctx || {};
  const task = c.task || {};

  // 1. Permission, first and failing closed. A client flag cannot stop a
  //    server-side agent, so this is read from the profile row on the server.
  const perm = autonomyAllowed(c.profile);
  if (!perm.allowed) return { allowed: false, reason: perm.reason, disable: false };

  // 2. The task's own state.
  if (task.status === "disabled") return { allowed: false, reason: "task_disabled", disable: false };
  if (TASK_INTENTS.indexOf(String(task.intent || "")) === -1) {
    return { allowed: false, reason: `unknown_intent:${task.intent}`, disable: true };
  }
  if (Number(task.depth || 0) > AUTONOMY_LIMITS.maxDepth) {
    return { allowed: false, reason: "depth_cap", disable: true };
  }
  if (Number(task.consecutive_failures || 0) >= AUTONOMY_LIMITS.maxFailures) {
    return { allowed: false, reason: "circuit_breaker", disable: true };
  }

  // 3. The loop detector. Same task, same actions, three times in a day.
  if (Number(c.loopHits || 0) >= AUTONOMY_LIMITS.loopRepeats) {
    return { allowed: false, reason: "action_loop", disable: true };
  }

  // 4. The separate budgets. Skipped, not disabled - a task that hit today's cap
  //    is fine tomorrow.
  if (Number(c.runsInWindow || 0) >= AUTONOMY_LIMITS.rateMax) {
    return { allowed: false, reason: "autonomy_rate_limited", disable: false };
  }
  if (Number(c.todayCostUsd || 0) >= autonomyBudget(c.profile)) {
    return { allowed: false, reason: "autonomy_cost_cap", disable: false };
  }

  return { allowed: true, reason: "", disable: false };
}

// Per-profile override of the daily autonomy budget, floored at zero and capped
// so a bad value in one row cannot become an unbounded spend.
export function autonomyBudget(profile) {
  const n = Number(profile && profile.autonomy_daily_cost_usd);
  if (!Number.isFinite(n) || n < 0) return AUTONOMY_LIMITS.dailyCostUsd;
  return Math.min(n, 2);
}

/**
 * Split a run's proposed tool calls into what may commit and what may not.
 *
 * Blocked calls are RETURNED, not dropped: an autonomous run that wanted to
 * change a budget is exactly the thing a human should get to see, and a silent
 * filter would make it invisible. `depth` blocks task creation from a task.
 */
export function filterAutonomousActions(calls, depth = 0) {
  const allowed = [];
  const blocked = [];
  for (const call of calls || []) {
    const name = String((call && call.name) || "");
    if (!name) { blocked.push({ name: "", call, reason: "unnamed_tool" }); continue; }
    if (name === "schedule_agent_task" || name === "create_agent_task") {
      // A task may not create a task. Enforced here as well as in the DB depth
      // check, because the model does not get to argue about it.
      blocked.push({ name, call, reason: depth >= AUTONOMY_LIMITS.maxDepth ? "depth_cap" : "not_autonomous" });
      continue;
    }
    if (AUTONOMOUS_TOOLS.indexOf(name) === -1) { blocked.push({ name, call, reason: "not_autonomous" }); continue; }
    allowed.push(call);
  }
  return { allowed, blocked };
}

// ---------------------------------------------------------------------------
// the loop detector's fingerprint
// ---------------------------------------------------------------------------

// Stable JSON: keys sorted at every level, so {a,b} and {b,a} hash the same.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * A fingerprint of what a run DID. FNV-1a, because this needs to be deterministic
 * and dependency-free on both sides, not cryptographic - the worst case for a
 * collision here is one extra "this looks like a loop" false positive.
 *
 * Note what is NOT in the hash: confidence, timestamps, ids. Two runs that
 * emitted the same answer with different confidence are the same loop.
 */
export function actionHash(calls) {
  const shaped = (calls || []).map((c) => ({
    name: String((c && c.name) || ""),
    args: (c && c.arguments) || {},
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const text = stableStringify(shaped);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** How many of `runs` inside the window carry this hash. */
export function countLoopHits(runs, hash, nowMs, windowH = AUTONOMY_LIMITS.loopWindowH) {
  if (!hash) return 0;
  const cutoff = Number(nowMs) - windowH * 3600000;
  let n = 0;
  for (const r of runs || []) {
    if (!r || r.action_hash !== hash) continue;
    const t = Date.parse(r.started_at || r.finished_at || "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------

/**
 * The claim key for one firing of a task.
 *
 * A recurring task keys on its OCCURRENCE ("2026-08-14T18:30"), so a retry of
 * the same occurrence collides. A one-shot has no recurrence to key on and uses
 * its fire_at minute - never its id alone, or a re-armed task could never fire
 * a second time.
 */
export function slotKeyFor(task, fireAtISO, tz = DEFAULT_TZ) {
  const zone = (task && task.tz) || tz || DEFAULT_TZ;
  const iso = fireAtISO || (task && task.fire_at);
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return null;
  const dayKey = dayKeyInTz(ms, zone);
  const rule = (task && task.recurrence) || null;
  if (rule) {
    const at = rule.at_time != null ? rule.at_time : hhmmInTz(ms, zone);
    return occurrenceKey(rule, dayKey, at);
  }
  return `${dayKey}T${hhmmInTz(ms, zone)}`;
}

function hhmmInTz(ms, zone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ms));
}

/**
 * When a recurring task should fire next, as an ISO instant, or null when the
 * series is finished (a `once`, or a rule past its UNTIL/COUNT).
 *
 * The day is chosen by integer arithmetic on date keys; the ONE place a zone is
 * involved is turning (day, minute) back into an instant, via lib/tz.mjs.
 * Advancing from `afterMs + 1 minute` rather than `afterMs` is what stops a
 * daily task from re-selecting the day it just ran.
 */
export function nextFireAt(task, afterMs, tz = DEFAULT_TZ) {
  const rule = task && task.recurrence;
  if (!rule || typeof rule !== "object") return null;
  if (ruleProblem(rule)) return null;
  const zone = (task && task.tz) || tz || DEFAULT_TZ;
  const at = minutesOfDay(rule.at_time);

  // Search from the day after the current fire when the rule has no time of day
  // (otherwise "daily" would return the same day forever); from the same day
  // when it does, since a later time on the same day is a genuine next fire.
  let cursorMs = Number(afterMs) + 60000;
  for (let i = 0; i < 8; i++) {
    const fromKey = dayKeyInTz(cursorMs, zone);
    const day = nextOccurrence(rule, fromKey);
    if (!day) return null;
    const ms = instantAtLocal(day, at == null ? 9 * 60 : at, zone);
    if (ms > Number(afterMs)) return new Date(ms).toISOString();
    // Same day, time already passed: step past it and try the next occurrence.
    cursorMs = instantAtLocal(day, 0, zone) + 86400000;
  }
  return null;
}

/**
 * Shape a natural-language schedule request into an agent_tasks row.
 * Returns { task } or { error } - never a half-built row, because a task with a
 * missing fire_at is one that silently never runs.
 */
export function buildTask(input) {
  const o = input || {};
  const intent = TASK_INTENTS.indexOf(String(o.intent || "")) === -1 ? "check" : String(o.intent);
  const prompt = String(o.prompt || "").trim();
  if (!prompt) return { error: "a task needs something to do" };
  const tz = o.tz || DEFAULT_TZ;

  let recurrence = null;
  if (o.recurrence && typeof o.recurrence === "object") {
    const problem = ruleProblem(o.recurrence);
    if (problem) return { error: `recurrence: ${problem}` };
    recurrence = o.recurrence;
  }

  let fireAt = o.fire_at || null;
  if (!fireAt && recurrence) {
    const at = minutesOfDay(recurrence.at_time);
    const fromKey = o.fromKey || dayKeyInTz(Number(o.nowMs) || Date.now(), tz);
    const day = nextOccurrence(recurrence, fromKey);
    if (!day) return { error: "that rule has no future date" };
    fireAt = new Date(instantAtLocal(day, at == null ? 9 * 60 : at, tz)).toISOString();
  }
  if (!fireAt) return { error: "a task needs a time to fire" };
  if (!Number.isFinite(Date.parse(String(fireAt)))) return { error: "fire_at is not a timestamp" };

  const depth = Math.max(0, Math.trunc(Number(o.depth) || 0));
  if (depth > AUTONOMY_LIMITS.maxDepth) return { error: "a task may not create a task" };

  return {
    task: {
      fire_at: new Date(Date.parse(String(fireAt))).toISOString(),
      tz,
      recurrence,
      intent,
      prompt: prompt.slice(0, 1000),
      created_by: o.created_by === "agent" || o.created_by === "system" ? o.created_by : "user",
      origin_ingestion_id: o.origin_ingestion_id || null,
      dedupe_key: o.dedupe_key ? String(o.dedupe_key).slice(0, 120) : null,
      depth,
    },
  };
}

/**
 * How a finished run should be recorded. Splitting this out of the runner is
 * what makes "silence" a first-class outcome with a row of its own rather than
 * an early `return` that leaves no trace.
 */
export function runOutcome({ spoke = false, actions = [], error = null, blocked = [], note = "" } = {}) {
  if (error) return { status: "failed", result: String(error).slice(0, 400), actions: 0 };
  if (blocked.length && !spoke) {
    return { status: "blocked", result: `blocked: ${blocked.map((b) => b.reason).join(", ")}`.slice(0, 400), actions: 0 };
  }
  if (!spoke) return { status: "silent", result: note || "silent: on track", actions: actions.length };
  return { status: "spoke", result: (note || "spoke").slice(0, 400), actions: actions.length };
}
