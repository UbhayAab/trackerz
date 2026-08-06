// The queue's RECOVERY path, which is the half nobody exercises until something
// has already gone wrong.
//
// The bug this locks shut: `claim_agent_tasks` reset a crashed run to
// 'scheduled' without touching `consecutive_failures`. The three-strikes breaker
// lives in the edge function and reads that column, so a task that killed the
// FUNCTION - an OOM, a timeout, a throw outside the try - was reset with its
// count still at zero, re-claimed, and crashed again, every ten minutes,
// forever. The breaker could not fire because nothing was counting the strikes.
//
// These are source assertions, not a live DB test, because the suite must run
// offline and free. They are still real: every one of them fails if a future
// rewrite of the function drops the property.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "supabase/migrations";

// The LAST migration that defines the function is the one that is live. Reading
// the first one would happily pass on a definition that has since been replaced.
const defining = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => /create or replace function public\.claim_agent_tasks/i.test(readFileSync(`${DIR}/${f}`, "utf8")));

assert.ok(defining.length, "no migration defines claim_agent_tasks");
const live = readFileSync(`${DIR}/${defining[defining.length - 1]}`, "utf8");

// The body of the live definition only - a property satisfied by a comment
// somewhere else in the file is not satisfied.
const body = live.slice(live.search(/create or replace function public\.claim_agent_tasks/i));
const code = body.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ---- 1. the pick is still non-blocking ----
assert.ok(/for update skip locked/i.test(code), "the pick lost FOR UPDATE SKIP LOCKED");

// ---- 2. the RESET is non-blocking too ----
// Two minute-ticks overlap the moment one run takes longer than 60 seconds. A
// bare UPDATE has the second block on the first's row locks instead of moving
// on, and a queue drainer that another drainer can block is not one.
const resetChunk = code.slice(0, code.indexOf("return query"));
assert.ok(/status = 'running'/i.test(resetChunk), "the reset no longer targets stuck 'running' rows");
assert.ok(/for update skip locked/i.test(resetChunk), "the RESET lost SKIP LOCKED and can now be blocked by a concurrent tick");

// ---- 3. a crash counts as a failure ----
assert.ok(
  /consecutive_failures\s*=\s*t\.consecutive_failures\s*\+\s*1/i.test(resetChunk),
  "the crash-recovery path stopped incrementing consecutive_failures - the three-strikes breaker is blind again",
);

// ---- 4. the breaker is enforced in SQL, not only in the edge function ----
// A task that crashes the function never reaches the function's copy of the
// rule, which is precisely the failure mode the breaker is most needed for.
assert.ok(/status\s*=\s*case/i.test(resetChunk) && /'disabled'/.test(resetChunk),
  "the reset no longer disables a task that keeps crashing");
assert.ok(/disabled_reason/i.test(resetChunk),
  "a disabled task must say WHY - a silent 'disabled' is indistinguishable from 'nothing was due'");

// ---- 5. backoff, so one poison task cannot starve the queue ----
// The pick is `order by fire_at`, so a task that fails instantly is always the
// oldest due row and is re-picked every single minute.
assert.ok(/fire_at\s*=\s*case/i.test(resetChunk) && /power\(2/i.test(resetChunk),
  "the reset lost its exponential backoff - a failing task will sit at the head of the queue");
// The backoff must be BOUNDED by the breaker, or it becomes an unbounded silent
// retreat into the future that looks identical to a task that simply never runs.
assert.ok(/v_max_failures/.test(resetChunk),
  "the backoff is not bounded by the failure limit");

// ---- 6. an index actually serves the reset's predicate ----
// ix_agent_tasks_due is partial on status = 'scheduled', so it matches none of
// `where status = 'running' and claimed_at < ...`.
const allSql = readdirSync(DIR).filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`${DIR}/${f}`, "utf8")).join("\n");
assert.ok(/create index[^;]*on public\.agent_tasks\(claimed_at\)[^;]*where status = 'running'/i.test(allSql),
  "no index serves the stuck-row reset; it will sequentially scan the table every minute");

// ---- 7. every pg_net call sets its own timeout ----
// The default is 2000 ms, which is shorter than a real model call and would turn
// a working run into an invisible timeout.
for (const m of allSql.matchAll(/select net\.http_post\(([\s\S]*?)\)\s*into/gi)) {
  assert.ok(/timeout_milliseconds\s*:=\s*\d+/.test(m[1]),
    `a net.http_post relies on the 2000 ms default timeout:\n${m[1].slice(0, 200)}`);
}

console.log("task-queue-contract tests passed: crashes are counted, the breaker trips in SQL, backoff is bounded, and the reset cannot block or table-scan");
