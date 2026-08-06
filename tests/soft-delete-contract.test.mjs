// SOFT-DELETE CONTRACT.
//
// A tombstone is only a delete if every read hides it. One read that forgets
// `.is("deleted_at", null)` is worse than having no soft delete at all: the row
// disappears from the feed the user is looking at and stays in the total they are
// reading, so "I deleted it" and "the number went down" quietly stop being the
// same statement.
//
// This walks every `.from("<softDeletable>")` chain in the data layer, works out
// whether it is a READ, and requires the filter. Writes are exempt; a short,
// NAMED allowlist covers the audit/history readers that intentionally see
// tombstones. Adding a read without the filter fails the build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOFT_DELETABLE_TABLES } from "../lib/undo-ledger.mjs";

const DATA = "src/services/supabase-data.js";
const rawSrc = readFileSync(DATA, "utf8");
const schema = readFileSync("supabase/schema.sql", "utf8");

// Blank out whole-line `//` comments before scanning, preserving byte offsets so
// the reported function name still lines up. This module's comments are prose and
// contain semicolons, which would otherwise cut a query chain in half and make the
// check pass or fail on punctuation. (Offsets preserved, not lines removed.)
function stripComments(text) {
  return text.replace(/^([ \t]*)\/\/.*$/gm, (m, indent) => indent + " ".repeat(m.length - indent.length));
}
const src = stripComments(rawSrc);

// Readers that MUST see tombstones, each with the reason it is exempt. A bare
// list would rot into "everything is allowlisted"; the reason is the point.
const ALLOWLIST = [
  ["fetchOpenDuplicatesWithRecords", "resolves both halves of a duplicate PAIR for the audit card - a pair with one side deleted must still render as a pair"],
  ["fetchStatementLedgerEntries", "re-import dedupe: a deleted bank row must stay visible, or re-importing the same statement recreates the entry the user removed"],
];

// ---- 1. every soft-deletable table declares the column ---------------------
for (const table of SOFT_DELETABLE_TABLES) {
  const head = `create table if not exists public.${table} (`;
  const start = schema.indexOf(head);
  assert.ok(start >= 0, `schema.sql has no table ${table}`);
  const block = schema.slice(start, start + schema.slice(start).search(/\r?\n\);/));
  assert.match(block, /\bdeleted_at timestamptz\b/, `schema.sql: ${table} has no deleted_at column`);
}
// The migration must be idempotent - it will be re-run against a live database.
const migration = readFileSync("supabase/migrations/20260806000022_soft_delete.sql", "utf8");
assert.match(migration, /add column if not exists deleted_at timestamptz/, "migration must use `add column if not exists`");
assert.match(migration, /create index if not exists/, "migration must use `create index if not exists`");
// The only hard delete in the system, and it is not reachable from a tool call.
assert.match(migration, /purge_soft_deleted/);
assert.match(migration, /revoke all on function public\.purge_soft_deleted\(int\) from anon, authenticated/);

// ---- 2. every read filters the tombstone -----------------------------------
// A chain runs from `.from("<table>")` to the next `;`, the next `.from("`, or a
// 1500-character ceiling - whichever comes first. That keeps two chained queries
// inside one statement (fetchDayLogs) from covering for each other.
function chainsFor(table) {
  const needle = `.from("${table}")`;
  const out = [];
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    const rest = src.slice(i + needle.length, i + needle.length + 1500);
    const stops = [rest.indexOf(";"), rest.indexOf('.from("')].filter((n) => n >= 0);
    const end = stops.length ? Math.min(...stops) : rest.length;
    out.push({ index: i, text: needle + rest.slice(0, end) });
  }
  return out;
}

// The enclosing `export function` / `export async function` name, for the
// allowlist and for a failure message someone can act on.
function functionAt(index) {
  const before = src.slice(0, index);
  const matches = [...before.matchAll(/export (?:async )?function (\w+)/g)];
  return matches.length ? matches[matches.length - 1][1] : "(top level)";
}

const WRITE = /\.(insert|upsert|update|delete)\(/;
let checked = 0;
const allowlistUsed = new Set();
for (const table of SOFT_DELETABLE_TABLES) {
  for (const chain of chainsFor(table)) {
    if (!chain.text.includes(".select(")) continue;   // not a read at all
    if (WRITE.test(chain.text)) continue;             // a write that returns rows
    const fn = functionAt(chain.index);
    const allowed = ALLOWLIST.find(([name]) => name === fn);
    if (allowed) {
      allowlistUsed.add(fn);
      assert.ok(
        !chain.text.includes('.is("deleted_at", null)'),
        `${fn} is on the tombstone allowlist but filters them out anyway - remove one or the other`,
      );
      continue;
    }
    checked += 1;
    assert.ok(
      chain.text.includes('.is("deleted_at", null)'),
      `${DATA}: ${fn}() reads ${table} without .is("deleted_at", null) - a deleted row would still be counted`,
    );
  }
}
assert.ok(checked >= 15, `expected the data layer to have many soft-deletable reads, found ${checked}`);

// An allowlist entry that no longer matches anything is a stale exemption.
for (const [name] of ALLOWLIST) {
  assert.ok(allowlistUsed.has(name), `allowlist entry ${name} matches no read - delete it`);
}

// ---- 3. the delete path is a tombstone, not a removal ----------------------
{
  const start = src.indexOf("export async function deleteRow(");
  assert.ok(start > 0, "deleteRow not found");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.match(body, /\.update\(\{ deleted_at: new Date\(\)\.toISOString\(\) \}\)/, "deleteRow must tombstone");
  assert.ok(!/\.delete\(\)/.test(body), "deleteRow must not hard-delete");
  // Deleting an already-deleted row must not restart the 30-day purge clock.
  assert.match(body, /\.is\("deleted_at", null\)/);
  assert.ok(src.includes("export async function restoreRow("), "a tombstone with no restore is just a delete");
}

// The erasure path is the ONE place a hard delete is correct: a user who asked to
// be forgotten must not be left half-remembered behind a tombstone.
assert.ok(/deleteAllUserData[\s\S]*?\.delete\(\)/.test(src), "deleteAllUserData still hard-deletes");

// ---- 4. the audit log cannot delete itself ---------------------------------
// revertTargetEvent used to DELETE the audit_log row it undid, so after an undo
// the app held no record that the target had ever changed, and none that it had
// been changed back. An audit log an ordinary user action can erase is not one.
{
  const files = ["src/services/supabase-data.js", "src/services/undo-service.js"];
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (let i = text.indexOf('.from("audit_log")'); i >= 0; i = text.indexOf('.from("audit_log")', i + 1)) {
      const chain = text.slice(i, i + 400).split(";")[0];
      assert.ok(!/\.delete\(/.test(chain), `${file}: an audit_log call site uses .delete( - the audit trail must be append-only`);
    }
  }
  assert.match(src, /action: "revert_target"/, "an undo must write a COMPENSATING audit row");
  assert.match(src, /target_id: auditId/, "the compensating row must point at what it reverses");
}

console.log(`soft-delete contract tests passed: ${checked} guarded reads, ${ALLOWLIST.length} named exemptions`);
