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
//   node scripts/capture.mjs --source=ocr "..."       # as if read off a photo
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
// Declare where the text came from, so the per-source capability gate can be
// exercised from the command line. Without this the only way to test that an
// OCR'd instruction is refused is to actually photograph one, which nobody does,
// which is how a security gate rots into a thing that is believed rather than
// checked.
const SOURCE = (args.find((a) => a.startsWith("--source=")) || "").slice(9) || null;
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

  // Undo what the SERVER says it wrote, before touching ai_actions - that table
  // is the only record of rows in tables with no ingestion_id of their own.
  //
  // The hardcoded list below could never reach `user_plans` or `budgets`, because
  // neither carries an ingestion_id. So `--undo` on a plan change reported
  // "undone: 0 domain rows" and left the plan in place, which is a worse lie than
  // failing outright: it claims the database is back where it started.
  const acted = await c.query(
    `select applied_record_table, applied_record_id from ai_actions
      where ingestion_id = $1 and applied_record_table is not null and applied_record_id is not null`,
    [id],
  ).catch(() => ({ rows: [] }));
  for (const a of acted.rows) {
    const r = await c
      .query(`delete from ${a.applied_record_table} where id = $1`, [a.applied_record_id])
      .catch(() => ({ rowCount: 0 }));
    if (r.rowCount) { console.log(`  removed ${r.rowCount} from ${a.applied_record_table}`); total += r.rowCount; }
  }

  // Then sweep by ingestion_id for anything written outside the tool path (the
  // deterministic salvage and the client-side appliers both do this).
  for (const t of ["food_logs", "ledger_entries", "workout_logs", "notes", "sleep_sessions", "hydration_logs", "reminders", "body_metrics", "wellness_logs"]) {
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
  body: JSON.stringify({ ingestionId, text, mode: "auto", ...(SOURCE ? { source: SOURCE } : {}) }),
});
const out = await res.json();

console.log(`\nAGENT (http ${res.status}, ${out.duplicate ? "duplicate replay" : "fresh run"})`);
for (const tc of out.toolCalls || []) {
  console.log(`  ${tc.name}  conf=${tc.confidence}${tc.arguments?._auto_expanded ? "  [salvage]" : ""}`);
  console.log(`     ${JSON.stringify(tc.arguments).slice(0, 190)}`);
}
if (out.rejectedDetail?.length) console.log(`  rejected: ${JSON.stringify(out.rejectedDetail)}`);
if (out.warning) console.log(`  warning: ${out.warning}`);
if (out.provenanceViolations?.length) {
  console.log(`  REFUSED on provenance: ${JSON.stringify(out.provenanceViolations)}`);
}

console.log("\nROWS THAT LANDED");
let landed = 0;

// Read what actually landed from ai_actions, NOT from a hardcoded table list.
//
// The old version listed tables and looked each one up by ingestion_id. Two ways
// that lied, and it did both:
//   1. A table missing from the list reported a perfectly good capture as lost.
//      `user_plans` was missing, so on 2026-08-06 a plan change that applied
//      correctly printed "(nothing - this capture was lost)".
//   2. Not every table HAS an ingestion_id. user_plans and budgets do not, so no
//      amount of adding to that list could ever have found them.
// ai_actions.applied_record_table/applied_record_id is the server's own record of
// what it wrote, so this cannot drift out of date when a tool is added.
const applied = await c.query(
  `select tool_name, status, applied_record_table, applied_record_id
     from ai_actions
    where ingestion_id = $1
    order by created_at`,
  [ingestionId],
).catch(() => ({ rows: [] }));

for (const a of applied.rows) {
  if (!a.applied_record_table || !a.applied_record_id) continue;
  const r = await c
    .query(`select * from ${a.applied_record_table} where id = $1`, [a.applied_record_id])
    .catch(() => ({ rows: [] }));
  for (const row of r.rows) {
    // Trim the noisy plumbing columns so the interesting fields are readable.
    for (const k of ["id", "user_id", "created_at", "updated_at", "ingestion_id"]) delete row[k];
    console.log(`  ${String(a.applied_record_table).padEnd(15)} ${JSON.stringify(row).slice(0, 220)}`);
    landed += 1;
  }
}

// An action that errored is not "nothing happened" - it is a failure nobody would
// otherwise see, since ai_actions.status='errored' is rendered in no surface.
const failedActions = applied.rows.filter((a) => a.status === "errored");
for (const a of failedActions) console.log(`  ERRORED         ${a.tool_name}`);

if (!landed) {
  const answered = applied.rows.some((a) => a.tool_name === "answer_question");
  const nonWriting = applied.rows.length > 0 && !failedActions.length;
  console.log(
    answered ? "  (nothing written - this capture was a QUESTION and was answered)"
      : nonWriting ? "  (nothing written - every tool this capture produced was non-writing)"
        : "  (nothing - this capture really did produce no rows)",
  );
}

await c.end();
console.log(`\ningestion ${ingestionId}`);
console.log(`undo with: node scripts/capture.mjs --undo ${ingestionId}\n`);
