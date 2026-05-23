// Applies SQL files to the Supabase project's Postgres directly.
// Reads DB URL from .env.local. Idempotent — every migration we ship is safe
// to re-run.
//
// Usage:
//   node scripts/db-push.mjs                          # apply schema + all migrations
//   node scripts/db-push.mjs supabase/setup.sql ...   # apply explicit files only

import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL missing in .env.local");
  process.exit(2);
}

function fileList() {
  if (process.argv.length > 2) return process.argv.slice(2);
  const files = [];
  if (existsSync("supabase/schema.sql")) files.push("supabase/schema.sql");
  const migDir = "supabase/migrations";
  if (existsSync(migDir)) {
    const migs = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const m of migs) files.push(join(migDir, m));
  }
  if (existsSync("supabase/setup.sql")) files.push("supabase/setup.sql");
  return files;
}

const files = fileList();
if (!files.length) {
  console.error("No SQL files to apply.");
  process.exit(2);
}

const sanitized = url.replace(/\?.*$/, "");
const client = new pg.Client({ connectionString: sanitized, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log("connected to", url.replace(/:[^:@/]+@/, ":***@"));

for (const file of files) {
  const path = resolve(file);
  const sql = await readFile(path, "utf8");
  process.stdout.write(`applying ${file} ... `);
  try {
    await client.query(sql);
    console.log("ok");
  } catch (err) {
    console.log("FAIL");
    console.error(`  ${err.message}`);
    if (err.position) console.error(`  at position ${err.position}`);
    process.exitCode = 1;
  }
}

await client.end();
console.log("done.");
