// Ad-hoc read-only query runner against the live Supabase Postgres.
// Usage: node scripts/q.mjs "select 1"   |   node scripts/q.mjs --file path.sql
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });

// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here - set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";

const argv = process.argv.slice(2);
const sql = argv[0] === "--file" ? readFileSync(argv[1], "utf8") : argv.join(" ");
if (!sql.trim()) { console.error("no sql"); process.exit(2); }

async function connect(url) {
  const c = new pg.Client({ connectionString: url.replace(/\?.*$/, ""), ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
  await c.connect();
  return c;
}

let client;
try {
  client = await connect(process.env.SUPABASE_DB_URL || FALLBACK);
} catch (e) {
  process.stderr.write(`direct failed (${e.message}); trying pooler\n`);
  client = await connect(FALLBACK);
}

try {
  const res = await client.query(sql);
  const results = Array.isArray(res) ? res : [res];
  for (const r of results) {
    if (r.command === "SELECT" || r.rows?.length) {
      console.log(JSON.stringify(r.rows, null, 1));
      console.log(`-- ${r.rows.length} rows`);
    } else {
      console.log(`-- ${r.command} ${r.rowCount ?? ""}`);
    }
  }
} catch (e) {
  console.error("SQL ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
