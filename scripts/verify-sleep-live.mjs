// Proves natural-language sleep capture works against the deployed agent, and
// reports the current 11-hour session so it can be corrected. Self-cleaning for
// the probe rows.
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb";
const FN = "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/agent";
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

const CASES = ["slept 7 hours last night", "went to bed at 11:30pm, woke up at 6:30am"];
const ingestions = [];
try {
  for (const text of CASES) {
    const ing = await client.query(
      `insert into raw_ingestions (user_id, source_type, capture_mode, raw_text, occurred_at, status)
       values ($1,'text','auto',$2, now(), 'queued') returning id`, [USER, text]);
    const id = ing.rows[0].id; ingestions.push(id);
    const res = await fetch(FN, {
      method: "POST", headers: { "content-type": "application/json", apikey: A, authorization: `Bearer ${JWT}` },
      body: JSON.stringify({ ingestionId: id, userId: USER, sourceType: "text", text, mode: "auto", mediaAssetIds: [] }),
    });
    await res.json().catch(() => ({}));
    const { rows } = await client.query(
      `select started_at::text, ended_at::text, extract(epoch from (ended_at - started_at))/3600 hours, note from sleep_sessions where ingestion_id=$1`, [id]);
    if (rows.length) {
      const r = rows[0];
      console.log(`"${text}"\n  -> ${r.hours ? Math.round(r.hours * 10) / 10 + "h" : "open"}  (${r.started_at} -> ${r.ended_at})${r.note ? "  note: " + r.note : ""}`);
    } else {
      console.log(`"${text}"\n  -> NO sleep_session created (FAIL)`);
    }
  }
  console.log("\n-- existing sessions --");
  const { rows: existing } = await client.query(
    `select id, started_at::text, ended_at::text, round((extract(epoch from (coalesce(ended_at,now()) - started_at))/3600)::numeric,1) hours, source from sleep_sessions where ingestion_id is null or source='button' order by started_at desc limit 5`);
  for (const r of existing) console.log(`  ${r.hours}h  ${r.started_at} -> ${r.ended_at}  [${r.source}]  id=${r.id}`);
} finally {
  for (const id of ingestions) {
    await client.query(`delete from sleep_sessions where ingestion_id=$1`, [id]);
    await client.query(`delete from ai_actions where ingestion_id=$1`, [id]);
    await client.query(`delete from ai_runs where ingestion_id=$1`, [id]);
    await client.query(`update raw_ingestions set duplicate_of_ingestion_id=null where id=$1`, [id]);
    await client.query(`delete from raw_ingestions where id=$1`, [id]);
  }
  await client.end();
  console.log(`\ncleaned up ${ingestions.length} probe captures`);
}
