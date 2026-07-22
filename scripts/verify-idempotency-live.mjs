// Replays the real 2026-07-09 incident against the DEPLOYED agent function:
// the same capture submitted twice, ~60s apart, which wrote the ledger twice.
// Asserts the second submit writes nothing. Self-cleaning.
//
// Usage: node scripts/verify-idempotency-live.mjs
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb";
const FN = "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/agent";
const TEXT = "Just ate 20 rupees lays and 60 for 3 boiled eggs and some riata";

const SUPA = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;

async function mintUserJwt(email) {
  const gen = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SECRET, authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  const link = await gen.json();
  const token = link.hashed_token || link.properties?.hashed_token;
  const ver = await fetch(`${SUPA}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON },
    body: JSON.stringify({ type: "magiclink", token_hash: token }),
  });
  return (await ver.json()).access_token;
}

const JWT = await mintUserJwt("ubhayvatsaanand@gmail.com");
const client = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const ingestions = [];
async function submit(label) {
  const ing = await client.query(
    `insert into raw_ingestions (user_id, source_type, capture_mode, raw_text, occurred_at, status)
     values ($1,'text','auto',$2, now(), 'queued') returning id`,
    [USER, TEXT],
  );
  const id = ing.rows[0].id;
  ingestions.push(id);
  const res = await fetch(FN, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${JWT}` },
    body: JSON.stringify({ ingestionId: id, userId: USER, sourceType: "text", text: TEXT, mode: "auto", mediaAssetIds: [] }),
  });
  const json = await res.json().catch(() => ({}));
  const { rows } = await client.query(
    `select coalesce(sum(amount),0)::float total, count(*)::int n from ledger_entries where ingestion_id = $1`,
    [id],
  );
  console.log(`${label}: http ${res.status}  duplicate=${json.duplicate === true}  ledger rows=${rows[0].n}  total=Rs ${rows[0].total}`);
  return { json, ...rows[0] };
}

let failures = 0;
try {
  const first = await submit("submit 1");
  const second = await submit("submit 2 (the re-send that used to double-book)");

  if (!(first.n > 0)) { console.log("FAIL: the first submit wrote nothing"); failures++; }
  if (second.n !== 0) { console.log(`FAIL: the second submit wrote ${second.n} ledger rows`); failures++; }
  if (second.json.duplicate !== true) { console.log("FAIL: the second submit was not flagged as a duplicate"); failures++; }

  const grand = first.total + second.total;
  console.log(`\ntotal booked across both submits: Rs ${grand}  (the 2026-07-09 incident booked Rs 240 for an Rs 80 purchase)`);
  console.log(failures ? "RESULT: FAIL" : "RESULT: PASS — the re-send was a no-op");
} finally {
  for (const t of ["ledger_entries", "food_logs", "workout_logs"]) {
    await client.query(`delete from ${t} where ingestion_id = any($1::uuid[])`, [ingestions]);
  }
  await client.query(`delete from ai_actions where ingestion_id = any($1::uuid[])`, [ingestions]);
  await client.query(`delete from ai_runs where ingestion_id = any($1::uuid[])`, [ingestions]);
  await client.query(`update raw_ingestions set duplicate_of_ingestion_id = null where id = any($1::uuid[])`, [ingestions]);
  await client.query(`delete from raw_ingestions where id = any($1::uuid[])`, [ingestions]);
  console.log(`cleaned up ${ingestions.length} probe ingestions`);
  await client.end();
}
process.exitCode = failures ? 1 : 0;
