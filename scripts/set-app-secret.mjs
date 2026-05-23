// Upsert a row in public.app_secrets. Used to push GEMINI_API_KEY into the DB
// so the edge function can read it without needing a deploy-time secret set.
//
// Usage:
//   node scripts/set-app-secret.mjs GEMINI_API_KEY "AIzaSy..."
//   GEMINI_API_KEY=... node scripts/set-app-secret.mjs GEMINI_API_KEY

import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });

const [, , name, valueArg] = process.argv;
if (!name) {
  console.error("usage: node scripts/set-app-secret.mjs NAME [VALUE]");
  process.exit(2);
}
const value = valueArg ?? process.env[name];
if (!value) {
  console.error(`no value provided and ${name} not in env`);
  process.exit(2);
}

const url = process.env.SUPABASE_DB_URL.replace(/\?sslmode=require/, "");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(
  `insert into public.app_secrets (name, value) values ($1, $2)
   on conflict (name) do update set value = excluded.value`,
  [name, value]
);
const r = await client.query(`select name, length(value) as len, updated_at from public.app_secrets where name = $1`, [name]);
console.log(`✓ ${name}: ${r.rows[0].len} chars stored at ${r.rows[0].updated_at.toISOString()}`);
await client.end();
