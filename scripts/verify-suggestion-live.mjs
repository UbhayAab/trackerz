// Confirms the deployed agent returns a spend suggestion for a capture that
// names the owner's recurring lunch but no price. Uses their REAL history.
// Self-cleaning.
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb";
const FN = "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/agent";
const TEXT = "egg curry roti with 3 eggs";
const S = process.env.SUPABASE_URL, K = process.env.SUPABASE_SECRET_KEY, A = process.env.SUPABASE_ANON_KEY;

const gen = await fetch(`${S}/auth/v1/admin/generate_link`, {
  method: "POST", headers: { "content-type": "application/json", apikey: K, authorization: `Bearer ${K}` },
  body: JSON.stringify({ type: "magiclink", email: "ubhayvatsaanand@gmail.com" }),
});
const link = await gen.json();
const ver = await fetch(`${S}/auth/v1/verify`, {
  method: "POST", headers: { "content-type": "application/json", apikey: A },
  body: JSON.stringify({ type: "magiclink", token_hash: link.hashed_token || link.properties?.hashed_token }),
});
const JWT = (await ver.json()).access_token;

const client = new pg.Client({ connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""), ssl: { rejectUnauthorized: false } });
await client.connect();
const ing = await client.query(
  `insert into raw_ingestions (user_id, source_type, capture_mode, raw_text, occurred_at, status)
   values ($1,'text','auto',$2, now(), 'queued') returning id`, [USER, TEXT]);
const id = ing.rows[0].id;

try {
  const res = await fetch(FN, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: A, authorization: `Bearer ${JWT}` },
    body: JSON.stringify({ ingestionId: id, userId: USER, sourceType: "text", text: TEXT, mode: "auto", mediaAssetIds: [] }),
  });
  const json = await res.json();
  const s = json.spendSuggestion;
  console.log(`capture: "${TEXT}"  (no amount stated)`);
  if (s) {
    console.log(`suggestion: Rs ${Math.round(s.amount)}  confidence ${s.confidence}`);
    console.log(`evidence:   ${s.evidence}`);
    console.log("RESULT: PASS - Jarvis offered a remembered amount with evidence");
  } else {
    console.log("suggestion: none");
    console.log("RESULT: no suggestion (not enough matching priced history for this signature)");
  }
} finally {
  await client.query(`delete from ledger_entries where ingestion_id=$1`, [id]);
  await client.query(`delete from food_logs where ingestion_id=$1`, [id]);
  await client.query(`delete from ai_actions where ingestion_id=$1`, [id]);
  await client.query(`delete from ai_runs where ingestion_id=$1`, [id]);
  await client.query(`update raw_ingestions set duplicate_of_ingestion_id=null where id=$1`, [id]);
  await client.query(`delete from raw_ingestions where id=$1`, [id]);
  await client.end();
  console.log("cleaned up probe");
}
