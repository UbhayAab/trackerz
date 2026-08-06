// Typecheck the edge functions.
//
// Why this exists: on 2026-08-04 a refactor replaced a `new Date().toISOString()`
// inside parseToolCalls() with a `nowIso` that only existed in runPipeline()'s
// scope. Every test passed - the whole suite runs against lib/ and src/, and
// NOTHING in it reads supabase/functions/*.ts - so the break reached production
// and the next real capture came back HTTP 500 and was lost. The edge function is
// the only code on the write path with no compiler in front of it. Now it has one.
//
// Deno-isms (Deno.env, https:/npm: imports) are not resolvable here and are
// filtered out; everything else is a real error.
//
// Usage: node scripts/typecheck-edge.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const TSC = "node_modules/typescript/bin/tsc";
const FILES = [
  "supabase/functions/agent/index.ts",
  "supabase/functions/jarvis/index.ts",
  "supabase/functions/gcal/index.ts",
].filter(existsSync);

// Errors that only mean "this is Deno, not Node" - not defects in our code.
const DENO_NOISE = /error TS2307|Cannot find name 'Deno'|Cannot find module 'https:|Cannot find module 'npm:|Cannot find module 'jsr:/;

// Known pre-existing errors, kept explicit so the check can be enforcing today
// rather than someday. Fix one and delete its entry.
//
// Matched on FILE + MESSAGE, never on line number: keying on "index.ts(1725,12)"
// meant any edit above the error silently turned it into a "new" failure, which
// is exactly the false alarm that makes a guard get switched off.
const KNOWN = [
  // agent: union narrowing on a dedupe candidate.
  ["agent/index.ts", "Property 'amount' does not exist on type '{ id: string; ingestionId: string;"],
  // jarvis: Intl.DateTimeFormat().formatToParts() reduced into an untyped {},
  // then read by field. Runtime-correct, unprovable to tsc without an interface.
  ["jarvis/index.ts", "Property 'year' does not exist on type '{}'"],
  ["jarvis/index.ts", "Property 'month' does not exist on type '{}'"],
  ["jarvis/index.ts", "Property 'day' does not exist on type '{}'"],
  ["jarvis/index.ts", "Property 'hour' does not exist on type '{}'"],
  ["jarvis/index.ts", "Property 'minute' does not exist on type '{}'"],
  ["jarvis/index.ts", "Property 'second' does not exist on type '{}'"],
  // jarvis: extra fields passed to the email template's arg type.
  ["jarvis/index.ts", "'stats' does not exist in type"],
  ["jarvis/index.ts", "Property 'foodLogs' does not exist on type"],
];

if (!existsSync(TSC)) {
  console.log("typescript not installed (npm i -D typescript) - skipping edge typecheck");
  process.exit(0);
}

const res = spawnSync(process.execPath, [
  TSC, "--noEmit", "--skipLibCheck", "--target", "es2022",
  "--module", "esnext", "--moduleResolution", "bundler", ...FILES,
], { encoding: "utf8" });

const lines = `${res.stdout || ""}${res.stderr || ""}`.split(/\r?\n/)
  .filter((l) => l.includes("error TS"))
  .filter((l) => !DENO_NOISE.test(l));

const fresh = lines.filter((l) => !KNOWN.some(([file, msg]) => l.includes(file) && l.includes(msg)));
const known = lines.length - fresh.length;

if (fresh.length) {
  console.error(`edge typecheck FAILED: ${fresh.length} error(s)`);
  fresh.forEach((l) => console.error(`  ${l}`));
  process.exit(1);
}
console.log(`edge typecheck passed: ${FILES.length} function(s), 0 new errors (${known} known)`);
