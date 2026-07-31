// Run a REAL capture through the deployed pipeline from the command line -
// exactly what the box on Home does, same edge function, same guards, same
// writes. Then print every row it produced.
//
// This is the honest way to check a pipeline change: not by reading the code,
// but by putting a sentence in and looking at what landed.
//
// Usage:
//   node scripts/capture.mjs "6 boiled eggs and 500ml curd"
//   node scripts/capture.mjs --dry "no gym today"     # local salvage only, no writes
//   node scripts/capture.mjs --undo <ingestionId>     # remove everything a capture wrote
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";
import { expandToolCalls } from "../lib/fan-out-expander.mjs";
import { estimateNutrition } from "../lib/food-nutrition.mjs";
import { classifyRequestKind } from "../lib/request-router.mjs";

loadEnv({ path: ".env.local" });
const S = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SECRET_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const EMAIL = "ubhayvatsaanand@gmail.com";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const undoAt = args.indexOf("--undo");
const text = args.filter((a) => !a.startsWith("--"))[undoAt >= 0 ? 1 : 0] || "";

// Direct host first, session pooler if it will not resolve - see db-connect.mjs.
const db = connectDb;

// ---- undo -------------------------------------------------------------------
if (undoAt >= 0) {
  const id = args[undoAt + 1];
  if (!id) { console.error("usage: --undo <ingestionId>"); process.exit(1); }
  const c = await db();
  let total = 0;
  for (const t of ["food_logs", "ledger_entries", "workout_logs", "notes", "sleep_sessions", "hydration_logs"]) {
    const r = await c.query(`delete from ${t} where ingestion_id = $1`, [id]).catch(() => ({ rowCount: 0 }));
    if (r.rowCount) { console.log(`  removed ${r.rowCount} from ${t}`); total += r.rowCount; }
  }
  await c.query("delete from ai_actions where ingestion_id = $1", [id]);
  await c.query("delete from ai_runs where ingestion_id = $1", [id]);
  await c.query("delete from raw_ingestions where id = $1", [id]);
  await c.end();
  console.log(`undone: ${total} domain row(s) + the capture itself`);
  process.exit(0);
}

if (!text) { console.error('usage: node scripts/capture.mjs "what happened"'); process.exit(1); }

// ---- what the deterministic layer alone makes of it -------------------------
console.log(`\nCAPTURE: "${text}"`);
console.log(`  routed as: ${classifyRequestKind(text)}`);
const est = estimateNutrition(text);
console.log(`  table prices: ${est.totals.calories} kcal · P${est.totals.protein_g} C${est.totals.carbs_g} F${est.totals.fat_g}` +
  `  (recognized=${est.recognized}${est.unknown.length ? `, unpriced: ${est.unknown.join(", ")}` : ""}` +
  `${est.unscaled?.length ? `, unscaled: ${est.unscaled.join(", ")}` : ""})`);
const salvage = expandToolCalls([], { evidence: text, now: new Date().toISOString() });
console.log(`  salvage alone would emit: ${salvage.map((t) => t.name.replace("create_", "").replace("_candidate", "")).join(", ") || "(nothing)"}`);

if (DRY) { console.log("\n--dry: nothing written.\n"); process.exit(0); }

// ---- the real thing ---------------------------------------------------------
async function mintSession() {
  const gen = await fetch(`${S}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify({ type: "magiclink", email: EMAIL }),
  });
  const link = await gen.json();
  const ver = await fetch(`${S}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON },
    body: JSON.stringify({ type: "magiclink", token_hash: link.hashed_token || link.properties?.hashed_token }),
  });
  return ver.json();
}

const session = await mintSession();
const c = await db();
const ing = await c.query(
  `insert into raw_ingestions (user_id, source_type, raw_text, status)
   values ($1,'text',$2,'queued') returning id`,
  [session.user.id, text],
);
const ingestionId = ing.rows[0].id;

const res = await fetch(`${S}/functions/v1/agent`, {
  method: "POST",
  headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${session.access_token}` },
  body: JSON.stringify({ ingestionId, text, mode: "auto" }),
});
const out = await res.json();

console.log(`\nAGENT (http ${res.status}, ${out.duplicate ? "duplicate replay" : "fresh run"})`);
for (const tc of out.toolCalls || []) {
  console.log(`  ${tc.name}  conf=${tc.confidence}${tc.arguments?._auto_expanded ? "  [salvage]" : ""}`);
  console.log(`     ${JSON.stringify(tc.arguments).slice(0, 190)}`);
}
if (out.rejectedDetail?.length) console.log(`  rejected: ${JSON.stringify(out.rejectedDetail)}`);
if (out.warning) console.log(`  warning: ${out.warning}`);

console.log("\nROWS THAT LANDED");
let landed = 0;
for (const [t, cols] of [
  ["food_logs", "description, calories_estimate, protein_g, carbs_g, fat_g"],
  ["ledger_entries", "amount, merchant, description"],
  ["workout_logs", "status, description"],
  ["notes", "kind, domain, body"],
  ["sleep_sessions", "started_at, ended_at"],
]) {
  const r = await c.query(`select ${cols} from ${t} where ingestion_id = $1`, [ingestionId]).catch(() => ({ rows: [] }));
  for (const row of r.rows) { console.log(`  ${t.padEnd(15)} ${JSON.stringify(row)}`); landed += 1; }
}
if (!landed) console.log("  (nothing - this capture was lost)");

await c.end();
console.log(`\ningestion ${ingestionId}`);
console.log(`undo with: node scripts/capture.mjs --undo ${ingestionId}\n`);
