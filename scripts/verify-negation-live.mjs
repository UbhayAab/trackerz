// End-to-end proof against the DEPLOYED agent function: send the exact captures
// that produced phantom workouts and assert the pipeline no longer records them
// as training. Cleans up everything it creates.
//
// Usage: node scripts/verify-negation-live.mjs
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here — set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb";
const FN = "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/agent";

const CASES = [
  { text: "No gym today", expect: "skipped" },
  { text: "Did not go to gym bro", expect: "skipped" },
  { text: "in gym, did workout A, bench 3x10 60kg", expect: "done" },
];

const SUPA = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;

// The agent function requires a real user JWT (it runs every write through RLS
// as the user). Mint one admin-side: generate a magiclink token, then verify it.
async function mintUserJwt(email) {
  const gen = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SECRET, authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!gen.ok) throw new Error(`generate_link ${gen.status}: ${(await gen.text()).slice(0, 200)}`);
  const link = await gen.json();
  const token = link.hashed_token || link.properties?.hashed_token;
  if (!token) throw new Error(`no hashed_token in generate_link response`);

  // token_hash (not `token`) is the form that exchanges without also needing the
  // email — passing both is rejected as "only an email or phone should be provided".
  const ver = await fetch(`${SUPA}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON },
    body: JSON.stringify({ type: "magiclink", token_hash: token }),
  });
  if (!ver.ok) throw new Error(`verify ${ver.status}: ${(await ver.text()).slice(0, 200)}`);
  const session = await ver.json();
  if (!session.access_token) throw new Error("no access_token from verify");
  return session.access_token;
}

const JWT = await mintUserJwt("ubhayvatsaanand@gmail.com");
console.log("minted a user JWT for the live check\n");

const client = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const created = { ingestions: [], workouts: [], foods: [], ledger: [] };
let failures = 0;

try {
  for (const c of CASES) {
    const ing = await client.query(
      `insert into raw_ingestions (user_id, source_type, capture_mode, raw_text, occurred_at, status)
       values ($1,'text','auto',$2, now(), 'queued') returning id`,
      [USER, c.text],
    );
    const ingestionId = ing.rows[0].id;
    created.ingestions.push(ingestionId);

    const res = await fetch(FN, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: ANON,
        authorization: `Bearer ${JWT}`,
      },
      // Same body shape src/services/agent-runner.js sends — the field is `text`.
      body: JSON.stringify({ ingestionId, userId: USER, sourceType: "text", text: c.text, mode: "auto", mediaAssetIds: [] }),
    });
    const body = await res.text();

    const { rows } = await client.query(
      `select id, description, status from workout_logs where ingestion_id = $1`,
      [ingestionId],
    );
    created.workouts.push(...rows.map((r) => r.id));
    const { rows: f } = await client.query(`select id from food_logs where ingestion_id = $1`, [ingestionId]);
    created.foods.push(...f.map((r) => r.id));
    const { rows: l } = await client.query(`select id from ledger_entries where ingestion_id = $1`, [ingestionId]);
    created.ledger.push(...l.map((r) => r.id));

    const got = rows.map((r) => r.status).join(",") || "(none)";
    const ok = rows.length === 1 && rows[0].status === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  "${c.text}"  -> expected ${c.expect}, got ${got}  [http ${res.status}]`);
    if (!ok) console.log(`      fn response: ${body.slice(0, 400)}`);
  }
} finally {
  // Always clean up the probe rows, pass or fail.
  for (const [table, ids] of [["workout_logs", created.workouts], ["food_logs", created.foods], ["ledger_entries", created.ledger]]) {
    if (ids.length) await client.query(`delete from ${table} where id = any($1::uuid[])`, [ids]);
  }
  if (created.ingestions.length) {
    await client.query(`delete from ai_actions where ingestion_id = any($1::uuid[])`, [created.ingestions]);
    await client.query(`delete from ai_runs where ingestion_id = any($1::uuid[])`, [created.ingestions]);
    await client.query(`delete from raw_ingestions where id = any($1::uuid[])`, [created.ingestions]);
  }
  console.log(`cleaned up ${created.ingestions.length} probe ingestions`);
  await client.end();
}

process.exitCode = failures ? 1 : 0;
