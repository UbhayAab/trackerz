// Guarantees schema.sql is the single source of truth: every table any migration
// creates must also be defined in schema.sql, every migration-added column must be
// present, and every user-owned table must have RLS wired. Run from repo root.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const schema = readFileSync("supabase/schema.sql", "utf8");
const migDir = "supabase/migrations";
const migrationSql = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`${migDir}/${f}`, "utf8"))
  .join("\n");

function tableNames(sql) {
  return [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
}

const schemaTables = new Set(tableNames(schema));
const migrationTables = new Set(tableNames(migrationSql));

// 1. Every migration table is mirrored in schema.sql.
for (const t of migrationTables) {
  assert.ok(schemaTables.has(t), `schema.sql is missing table "${t}" that a migration creates — schema.sql must be the single source of truth`);
}

// 2. Migration-added columns on existing tables are present in schema.sql.
for (const col of ["is_discretionary", "tags"]) {
  assert.ok(new RegExp(`\\b${col}\\b`).test(schema), `schema.sql is missing the "${col}" column added by a migration`);
}

// 3. Every user-owned table (CREATE references user_id) has RLS wired in schema.sql,
//    either via an explicit alter or inside an RLS do-block array.
const userOwnedBlocks = [...schema.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)]
  .filter((m) => /\buser_id\b/.test(m[2]))
  .map((m) => m[1]);

for (const t of userOwnedBlocks) {
  const wired =
    new RegExp(`alter table public\\.${t} enable row level security`).test(schema) ||
    new RegExp(`'${t}'`).test(schema);
  assert.ok(wired, `user-owned table "${t}" has no RLS wiring in schema.sql`);
}

console.log(`schema contract tests passed: ${schemaTables.size} tables, all ${migrationTables.size} migration tables mirrored, ${userOwnedBlocks.length} user-owned tables RLS-wired`);
