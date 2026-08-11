// Fires the jarvis edge function the same way pg_cron does, for checking the
// engine without waiting for a scheduled slot.
//
// Usage: node scripts/jarvis-run.mjs status|morning|midday|evening|closeout|task [--force]
//        node scripts/jarvis-run.mjs closeout --force --date=2026-08-09
//
// `task` is the per-minute tick (20260806000030): timed reminders plus the
// agent_tasks agenda. It is SILENT when nothing is due, which is the expected
// result almost every time you run it by hand.
//
// --force skips the job_runs slot claim, so a slot already taken by pg_cron or
// the GitHub heartbeat still runs. WITHOUT it a second run of the same slot on
// the same day returns `skipped: "slot_claimed_elsewhere"` - that is the claim
// working, not a failure. On `task`, --force additionally deletes the
// occurrence's agent_task_runs row so the same occurrence can be replayed.
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here - set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const action = process.argv[2] || "status";
const force = process.argv.includes("--force");
// CLOSING A DAY THAT IS NOT YESTERDAY.
//
// The function has always accepted `payload.date` for closeout; this script just
// never sent it, so the only re-closable day was yesterday. That matters because
// a day gets closed at 00:05 and BACKDATED rows keep arriving after it - on
// 2026-08-09 the paneer meal was entered at 02:25 the next morning, four hours
// after the close, and the stored summary was frozen at 380 kcal / 56 g on a day
// that really held 2,910 kcal and 176 g. Nothing re-opened it, so the morning
// brief read that day's protein off a summary describing one of its two meals.
const DATE = (process.argv.find((a) => /^--date=\d{4}-\d{2}-\d{2}$/.test(a)) || "").slice(7) || null;

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
  body: JSON.stringify(DATE ? { action, force, date: DATE } : { action, force }),
});
console.log("http", res.status);
console.log(JSON.stringify(await res.json(), null, 1));
