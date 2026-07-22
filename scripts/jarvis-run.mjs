// Fires the jarvis edge function the same way pg_cron does, for checking the
// engine without waiting for a scheduled slot.
//
// Usage: node scripts/jarvis-run.mjs status|morning|evening|closeout [--force]
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here - set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const action = process.argv[2] || "status";
const force = process.argv.includes("--force");

const c = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query("select value from app_secrets where name = 'JARVIS_CRON_SECRET'");
await c.end();

const res = await fetch("https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/jarvis", {
  method: "POST",
  headers: { "content-type": "application/json", "x-jarvis-secret": rows[0].value },
  body: JSON.stringify({ action, force }),
});
console.log("http", res.status);
console.log(JSON.stringify(await res.json(), null, 1));
