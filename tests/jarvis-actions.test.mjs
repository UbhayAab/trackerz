// JARVIS ACTION WIRING - the guard against a cron slot that can never run.
//
// The handler's allowlist read ["closeout", "morning", "evening", "status"] while
// runMidday sat dispatched ~35 lines below it on action === "midday". So the
// 14:30 IST pg_cron slot (migration 20260731000019_jarvis_midday_slot.sql) and the
// GitHub heartbeat had BOTH been getting a 400 unknown_action from the day the
// slot was built - the protein/gym pace nudge never fired once, and nothing
// anywhere said so.
//
// Three sets have to agree and this test compares all three as sets, from source
// text (the function is Deno TS and cannot be imported from Node):
//   1. what the handler ACCEPTS  (the allowlist)
//   2. what the handler DISPATCHES (the run* calls in the loop)
//   3. what the CLOCKS actually send (pg_cron + the GitHub heartbeat)
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const src = readFileSync("supabase/functions/jarvis/index.ts", "utf8");
const serveAt = src.indexOf("Deno.serve");
assert.ok(serveAt !== -1, "no Deno.serve handler in the jarvis function");
const handler = src.slice(serveAt);

// --- 1. what the handler accepts ---------------------------------------------

const guard = handler.match(/if \(!\[([^\]]*)\]\.includes\(action\)\)/);
assert.ok(guard, "could not find the action allowlist guard in the jarvis handler");
const allowed = new Set([...guard[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
assert.ok(allowed.size >= 4, `allowlist looks truncated: ${[...allowed].join(", ")}`);
assert.ok(/unknown_action/.test(handler), "the allowlist must still reject anything else with unknown_action");

// --- 2. what the handler dispatches ------------------------------------------
// Every branch of the loop calls run<Action>(...) - including the closeout
// fall-through, which has no `action ===` test of its own. Lower-casing the
// handler name is what makes the fall-through visible to this test at all.
const dispatched = new Set(
  [...handler.matchAll(/\brun([A-Z]\w+)\s*\(/g)].map((m) => m[1].toLowerCase()),
);
assert.ok(dispatched.size >= 4, `dispatch loop looks truncated: ${[...dispatched].join(", ")}`);

assert.deepEqual(
  [...allowed].sort(), [...dispatched].sort(),
  `jarvis action allowlist and dispatch loop disagree - accepted-but-undispatched=${
    [...allowed].filter((a) => !dispatched.has(a)).join(",") || "none"
  } dispatched-but-rejected-with-400=${
    [...dispatched].filter((d) => !allowed.has(d)).join(",") || "none"
  }`,
);

// Every allowlisted action needs a real handler function, not just a call site.
for (const action of allowed) {
  const fnName = `run${action[0].toUpperCase()}${action.slice(1)}`;
  assert.ok(
    new RegExp(`async function ${fnName}\\(`).test(src),
    `action "${action}" is allow-listed and dispatched but ${fnName}() is not defined`,
  );
}

// The slot this whole test exists for.
assert.ok(allowed.has("midday"), "midday is missing from the allowlist again - the 14:30 IST slot will 400");

// --- 3. what the clocks actually send ----------------------------------------
// A slot wired to a scheduler that the function rejects is invisible: pg_cron
// swallows the 400 and the run simply never happens.
const cronActions = new Set();
for (const f of readdirSync("supabase/migrations")) {
  const sql = readFileSync(`supabase/migrations/${f}`, "utf8");
  for (const m of sql.matchAll(/jarvis_ping\(\s*'([a-z_]+)'\s*\)/g)) cronActions.add(m[1]);
}
assert.ok(cronActions.size >= 4, `expected the pg_cron slots to name their actions, found ${[...cronActions].join(", ")}`);
for (const a of cronActions) {
  assert.ok(allowed.has(a), `pg_cron fires jarvis_ping('${a}') but the function 400s it - that slot can never run`);
}

const wf = ".github/workflows/jarvis-heartbeat.yml";
if (existsSync(wf)) {
  const yml = readFileSync(wf, "utf8");
  const heartbeatActions = new Set([...yml.matchAll(/ACTION=([a-z]+)\b/g)].map((m) => m[1]));
  assert.ok(heartbeatActions.size >= 3, `heartbeat action mapping looks truncated: ${[...heartbeatActions].join(", ")}`);
  for (const a of heartbeatActions) {
    assert.ok(allowed.has(a), `the GitHub heartbeat sends action "${a}" but the function 400s it`);
  }
}

console.log(`jarvis-actions tests passed: ${allowed.size} actions accepted, dispatched and scheduled in agreement`);
