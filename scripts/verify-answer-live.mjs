// Proves the DEPLOYED agent function answers a question instead of silently
// filing it. Self-cleaning: deletes the ingestion/run/actions it creates.
//
// The bug this guards: a question used to route to request_user_review tagged
// "query", a queue nothing has ever rendered. Four such rows sat at 'proposed'
// forever, and the two real questions the owner typed on 2026-07-24 ("Wtf
// happenend", "Look at the cal numbers that you have pushed. Fix all") produced
// zero rows and no reply at all.
//
// Usage: node scripts/verify-answer-live.mjs
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });
const S = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SECRET_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const EMAIL = "ubhayvatsaanand@gmail.com";

const QUESTIONS = [
  "How much have I spent this week?",
  "Am I on track with my protein?",
  "How many steps did I do yesterday?",   // no step source exists - must say so
];

async function mintSession() {
  const gen = await fetch(`${S}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify({ type: "magiclink", email: EMAIL }),
  });
  const link = await gen.json();
  const token = link.hashed_token || link.properties?.hashed_token;
  const ver = await fetch(`${S}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON },
    body: JSON.stringify({ type: "magiclink", token_hash: token }),
  });
  return ver.json();
}

const session = await mintSession();
const jwt = session.access_token;
const userId = session.user.id;

const client = await connectDb();

let failures = 0;
const created = [];

for (const question of QUESTIONS) {
  const ing = await client.query(
    `insert into raw_ingestions (user_id, source_type, raw_text, status)
     values ($1, 'text', $2, 'queued') returning id`,
    [userId, question],
  );
  const ingestionId = ing.rows[0].id;
  created.push(ingestionId);

  const res = await fetch(`${S}/functions/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ ingestionId, text: question, mode: "auto" }),
  });
  const out = await res.json();
  const calls = out.toolCalls || [];
  const answer = calls.find((c) => c.name === "answer_question");
  const writes = calls.filter((c) => String(c.name || "").startsWith("create_"));

  console.log(`\nQ: ${question}`);
  if (!res.ok || !out.ok) {
    console.log(`   FAIL http ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
    failures += 1;
    continue;
  }
  console.log(`   tools: ${calls.map((c) => c.name).join(", ") || "(none)"} | rejected: ${out.rejected} | raw: ${JSON.stringify(out).slice(0, 300)}`);
  if (!answer) {
    console.log("   FAIL no answer_question - the question got no reply");
    failures += 1;
  } else {
    console.log(`   A: ${answer.arguments?.answer}`);
    if (answer.arguments?.basis) console.log(`   basis: ${answer.arguments.basis}`);
  }
  // A question must never log an event.
  if (writes.length) {
    console.log(`   FAIL a question wrote ${writes.length} domain row(s): ${writes.map((w) => w.name).join(", ")}`);
    failures += 1;
  }
}

// Clean up everything this script created, in FK order.
for (const id of created) {
  await client.query("delete from ai_actions where ingestion_id = $1", [id]);
  await client.query("delete from ai_runs where ingestion_id = $1", [id]);
  await client.query("delete from raw_ingestions where id = $1", [id]);
}
await client.end();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall answer checks passed - the app replies to questions");
process.exitCode = failures ? 1 : 0;
