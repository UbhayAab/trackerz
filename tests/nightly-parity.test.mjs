// The nightly edge function runs the SAME pure intelligence the app runs, via
// byte-identical copies under supabase/functions/_shared/. This test fails the
// build the moment a source module and its edge mirror drift, and sanity-checks
// the nightly function's wiring (imports only from _shared, ops present).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MIRRORS = [
  ["lib/diet-scaffold.mjs", "supabase/functions/_shared/lib/diet-scaffold.mjs"],
  ["lib/plan-merge.mjs", "supabase/functions/_shared/lib/plan-merge.mjs"],
  ["lib/agent-core.mjs", "supabase/functions/_shared/lib/agent-core.mjs"],
  ["lib/habituation.mjs", "supabase/functions/_shared/lib/habituation.mjs"],
  ["lib/mind-wander.mjs", "supabase/functions/_shared/lib/mind-wander.mjs"],
  ["lib/consolidate.mjs", "supabase/functions/_shared/lib/consolidate.mjs"],
  ["lib/calibration.mjs", "supabase/functions/_shared/lib/calibration.mjs"],
  ["src/analytics/insights-engine.js", "supabase/functions/_shared/src/analytics/insights-engine.js"],
  ["src/analytics/insights-feed.js", "supabase/functions/_shared/src/analytics/insights-feed.js"],
  ["src/analytics/period-aggregator.js", "supabase/functions/_shared/src/analytics/period-aggregator.js"],
  ["src/analytics/opportunity-cost.js", "supabase/functions/_shared/src/analytics/opportunity-cost.js"],
  ["src/analytics/cashflow-forecast.js", "supabase/functions/_shared/src/analytics/cashflow-forecast.js"],
  ["src/analytics/briefing.js", "supabase/functions/_shared/src/analytics/briefing.js"],
  ["src/domain/goals.js", "supabase/functions/_shared/src/domain/goals.js"],
  ["src/domain/diet/plan.js", "supabase/functions/_shared/src/domain/diet/plan.js"],
  ["src/domain/diet/protein-gap.js", "supabase/functions/_shared/src/domain/diet/protein-gap.js"],
  ["src/domain/diet/late-snack-detector.js", "supabase/functions/_shared/src/domain/diet/late-snack-detector.js"],
  ["src/domain/diet/eating-window.js", "supabase/functions/_shared/src/domain/diet/eating-window.js"],
  ["src/domain/diet/weight-rolling-avg.js", "supabase/functions/_shared/src/domain/diet/weight-rolling-avg.js"],
  ["src/domain/wellness/sleep-debt.js", "supabase/functions/_shared/src/domain/wellness/sleep-debt.js"],
  ["src/domain/money/budget-alerts.js", "supabase/functions/_shared/src/domain/money/budget-alerts.js"],
  ["src/domain/money/transfer-detector.js", "supabase/functions/_shared/src/domain/money/transfer-detector.js"],
  ["src/domain/money/refund-matcher.js", "supabase/functions/_shared/src/domain/money/refund-matcher.js"],
  ["src/data/nifty-monthly-closes.js", "supabase/functions/_shared/src/data/nifty-monthly-closes.js"],
];

for (const [src, mirror] of MIRRORS) {
  const a = readFileSync(src, "utf8");
  const b = readFileSync(mirror, "utf8");
  assert.equal(a, b, `MIRROR DRIFT: ${mirror} differs from ${src} — re-copy the file (the nightly fn must run exactly what the app runs)`);
}

// The mirrored closure must be complete: every relative import inside _shared
// must resolve to a file that is itself mirrored (or within _shared).
import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const file of walk("supabase/functions/_shared")) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = normalize(join(dirname(file), m[1]));
    assert.ok(existsSync(target), `BROKEN MIRROR IMPORT: ${file} imports ${m[1]} but ${target} is not mirrored`);
  }
}

// Nightly function wiring.
const nightly = readFileSync("supabase/functions/nightly/index.ts", "utf8");
for (const needed of [
  "buildInsightFeed", "buildBriefing", "resolveDietTargets", "planForDate",
  "x-nightly-secret", "NIGHTLY_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY",
  "push_subscriptions", "briefings", "briefing_enabled",
  'op === "vapid"', 'op === "test-push"', 'op === "run-self"',
]) {
  assert.ok(nightly.includes(needed), `nightly/index.ts is missing "${needed}"`);
}
// Every app-logic import must come from _shared (never a fresh reimplementation).
for (const m of nightly.matchAll(/from\s+"(\.[^"]+)"/g)) {
  assert.ok(m[1].startsWith("../_shared/"), `nightly imports ${m[1]} — app logic must come from ../_shared mirrors`);
}
// The cron registration must target the nightly function with the secret header.
const cron = readFileSync("supabase/nightly-cron.sql", "utf8");
assert.ok(cron.includes("/functions/v1/nightly"), "cron SQL must POST to the nightly function");
assert.ok(cron.includes("x-nightly-secret"), "cron SQL must send the shared secret header");
assert.ok(cron.includes("NIGHTLY_SECRET"), "cron SQL must read NIGHTLY_SECRET from app_secrets");

console.log(`nightly parity tests passed: ${MIRRORS.length} mirrors byte-identical, closure complete, wiring intact`);
