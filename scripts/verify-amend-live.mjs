// PROVE AN AMENDMENT AGAINST THE DEPLOYED AGENT, END TO END.
//
// Reading the code does not tell you whether "actually it was 50 g not 30 g"
// changes the row or writes a second one. This does: it logs a snack through the
// real edge function, amends it through the real edge function, prints the row
// before and after, then undoes the amendment and prints it again.
//
// Self-cleaning: every row it creates is removed at the end, including the
// ai_actions / ai_runs / raw_ingestions rows and the audit trail entries this
// run wrote. If it dies half way, re-run it - the cleanup is by ingestion id and
// is idempotent.
//
// Usage: node scripts/verify-amend-live.mjs
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });
const S = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SECRET_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const EMAIL = "ubhayvatsaanand@gmail.com";

// A description no real capture would collide with, so the resolver's answer is
// about the mechanism and not about luck.
const MARKER = `zzverify${Date.now().toString().slice(-6)}`;
const LOG_TEXT = `30 g aloo bhujia ${MARKER}`;
const AMEND_TEXT = `actually the ${MARKER} aloo bhujia was 50 g not 30 g`;

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
const userId = session.user.id;
const c = await connectDb();
const ingestions = [];

async function capture(text) {
  const ing = await c.query(
    `insert into raw_ingestions (user_id, source_type, raw_text, status)
     values ($1,'text',$2,'queued') returning id`,
    [userId, text],
  );
  const ingestionId = ing.rows[0].id;
  ingestions.push(ingestionId);
  const res = await fetch(`${S}/functions/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ ingestionId, text, mode: "auto" }),
  });
  return { ingestionId, out: await res.json(), status: res.status };
}

function show(row) {
  if (!row) return "(gone)";
  return `description=${JSON.stringify(row.description)} kcal=${row.calories_estimate} protein=${row.protein_g} deleted_at=${row.deleted_at}`;
}

async function readRow(id) {
  const r = await c.query("select id, description, calories_estimate, protein_g, deleted_at from food_logs where id = $1", [id]);
  return r.rows[0] || null;
}

// THE DUPLICATE CHECK. Counted by INGESTION, not by text: the model routinely
// rewrites the description it was given (it dropped the marker token on the very
// first run of this script), so matching on the words would quietly compare
// nothing and pass. Every food row either capture caused carries that capture's
// ingestion id, and "the amendment changed the row" means this stays at 1.
async function countRunRows() {
  if (!ingestions.length) return 0;
  const r = await c.query(
    "select count(*)::int as n from food_logs where user_id = $1 and ingestion_id = any($2::uuid[]) and deleted_at is null",
    [userId, ingestions],
  );
  return r.rows[0].n;
}

// ---- 1. log it -------------------------------------------------------------
console.log(`\n[1] LOG   "${LOG_TEXT}"`);
const logged = await capture(LOG_TEXT);
console.log(`    http ${logged.status}, tools: ${(logged.out.toolCalls || []).map((t) => t.name).join(", ") || "(none)"}`);
const foodRow = await c.query(
  `select applied_record_id from ai_actions
    where ingestion_id = $1 and applied_record_table = 'food_logs' and applied_record_id is not null limit 1`,
  [logged.ingestionId],
);
const rowId = foodRow.rows[0]?.applied_record_id;
if (!rowId) {
  console.error("    the log did not land - nothing to amend. Rows:", JSON.stringify(logged.out.toolCalls));
  await cleanup();
  process.exit(1);
}
console.log(`    row ${rowId}: ${show(await readRow(rowId))}`);
console.log(`    live food rows from this run: ${await countRunRows()}`);

// ---- 2. amend it -----------------------------------------------------------
console.log(`\n[2] AMEND "${AMEND_TEXT}"`);
const amended = await capture(AMEND_TEXT);
console.log(`    http ${amended.status}, tools: ${(amended.out.toolCalls || []).map((t) => t.name).join(", ") || "(none)"}`);
for (const a of amended.out.amendments || []) {
  console.log(`    amendment: status=${a.status} ref=${JSON.stringify(a.targetRef)} window=${a.window?.from}..${a.window?.to} reason=${a.reason ?? "-"}`);
  if (a.plan) console.log(`      plan: ${a.plan.op} ${a.plan.table}#${a.plan.id} columns=[${(a.plan.columns || []).join(", ")}]`);
}
if (amended.out.rejectedDetail?.length) console.log(`    rejected: ${JSON.stringify(amended.out.rejectedDetail)}`);

const action = await c.query(
  `select id, tool_name, status, arguments from ai_actions
    where ingestion_id = $1 and tool_name in ('amend_log_candidate','delete_log_candidate') limit 1`,
  [amended.ingestionId],
);
const amendAction = action.rows[0];
if (!amendAction) {
  console.error("    the agent did not emit an amendment for that sentence.");
  await cleanup();
  process.exit(1);
}
console.log(`    ai_actions ${amendAction.id} tool=${amendAction.tool_name} status=${amendAction.status} (destructive tier -> waits for a tap)`);

// ---- 3. confirm it (the tap the diff card would have taken) ----------------
const plan = amendAction.arguments?._amend;
if (!plan || plan.op !== "update") {
  console.error(`    no resolved plan on the action: ${JSON.stringify(amendAction.arguments?._amend_status)} ${JSON.stringify(amendAction.arguments?._amend_reason)}`);
  await cleanup();
  process.exit(1);
}
console.log(`\n[3] CONFIRM the plan (what tapping "Change it" on the diff card does)`);
const setSql = plan.columns.map((col, i) => `${col} = $${i + 1}`).join(", ");
const setVals = plan.columns.map((col) => plan.values[col]);
await c.query(
  `update ${plan.table} set ${setSql} where id = $${plan.columns.length + 1} and user_id = $${plan.columns.length + 2} and deleted_at is null`,
  [...setVals, plan.id, userId],
);
await c.query(
  `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
   values ($1,'ai_amend_log',$2,$3,$4,$5,'verify-amend-live')`,
  [userId, plan.table, plan.id, JSON.stringify(plan.before), JSON.stringify(plan.values)],
);
await c.query(
  `update ai_actions set status='applied', applied_at=now(), applied_record_table=$2, applied_record_id=$3, undo_payload=$4 where id=$1`,
  [amendAction.id, plan.table, plan.id, JSON.stringify({ v: 2, op: "update", table: plan.table, id: plan.id, before: plan.before, after: plan.values, columns: plan.columns })],
);
console.log(`    row ${rowId}: ${show(await readRow(rowId))}`);
console.log(`    live food rows from this run: ${await countRunRows()}  <-- 1 means it CHANGED the row, 2 would mean it duplicated it`);

// ---- 4. undo it ------------------------------------------------------------
console.log(`\n[4] UNDO  (restore only the named columns)`);
const undo = await c.query("select undo_payload from ai_actions where id = $1", [amendAction.id]);
const payload = undo.rows[0].undo_payload;
const cols = payload.columns;
const undoSql = cols.map((col, i) => `${col} = $${i + 1}`).join(", ");
await c.query(
  `update ${payload.table} set ${undoSql} where id = $${cols.length + 1} and user_id = $${cols.length + 2}`,
  [...cols.map((col) => payload.before[col]), payload.id, userId],
);
console.log(`    columns restored: [${cols.join(", ")}]`);
console.log(`    row ${rowId}: ${show(await readRow(rowId))}`);

// ---- 4b. and now the dangerous one: a DELETE ------------------------------
console.log(`\n[4b] DELETE "delete the 30 g aloo bhujia I logged today"`);
const deleted = await capture(`delete the 30 g aloo bhujia I logged today`);
console.log(`    http ${deleted.status}, tools: ${(deleted.out.toolCalls || []).map((t) => t.name).join(", ") || "(none)"}`);
for (const a of deleted.out.amendments || []) {
  console.log(`    amendment: status=${a.status} ref=${JSON.stringify(a.targetRef)} window=${a.window?.from}..${a.window?.to} reason=${a.reason ?? "-"}`);
  if (a.plan) console.log(`      plan: ${a.plan.op} ${a.plan.table}#${a.plan.id}`);
}
const delAction = (await c.query(
  `select id, arguments from ai_actions where ingestion_id = $1 and tool_name = 'delete_log_candidate' limit 1`,
  [deleted.ingestionId],
)).rows[0];
if (delAction?.arguments?._amend?.op === "soft_delete") {
  const dp = delAction.arguments._amend;
  await c.query(`update ${dp.table} set deleted_at = now() where id = $1 and user_id = $2 and deleted_at is null`, [dp.id, userId]);
  console.log(`    after confirm: ${show(await readRow(dp.id))}`);
  console.log(`    live food rows from this run: ${await countRunRows()}  <-- the tombstone removes it from every total`);
  await c.query(`update ${dp.table} set deleted_at = null where id = $1 and user_id = $2`, [dp.id, userId]);
  console.log(`    after UNDO (clear the tombstone, never a re-insert): ${show(await readRow(dp.id))}`);
} else {
  console.log(`    (no delete plan: ${JSON.stringify(delAction?.arguments?._amend_status)} ${JSON.stringify(delAction?.arguments?._amend_reason)})`);
}

// ---- 5. clean up -----------------------------------------------------------
async function cleanup() {
  for (const id of ingestions) {
    const acted = await c.query(
      `select applied_record_table, applied_record_id from ai_actions
        where ingestion_id = $1 and applied_record_table is not null and applied_record_id is not null`,
      [id],
    ).catch(() => ({ rows: [] }));
    for (const a of acted.rows) {
      await c.query(`delete from ${a.applied_record_table} where id = $1`, [a.applied_record_id]).catch(() => {});
    }
    for (const t of ["food_logs", "ledger_entries", "workout_logs", "notes"]) {
      await c.query(`delete from ${t} where ingestion_id = $1`, [id]).catch(() => {});
    }
    await c.query("delete from ai_actions where ingestion_id = $1", [id]).catch(() => {});
    await c.query("delete from ai_runs where ingestion_id = $1", [id]).catch(() => {});
    await c.query("delete from raw_ingestions where id = $1", [id]).catch(() => {});
  }
  await c.query("delete from audit_log where user_id = $1 and source = 'verify-amend-live'", [userId]).catch(() => {});
  await c.query("delete from food_logs where user_id = $1 and description ilike $2", [userId, `%${MARKER}%`]).catch(() => {});
}

console.log(`\n[5] CLEANUP`);
await cleanup();
const left = await countRunRows();
console.log(`    live food rows from this run after cleanup: ${left}`);
await c.end();
console.log(left === 0 ? "\nverify-amend-live: OK\n" : "\nverify-amend-live: CLEANUP INCOMPLETE\n");
process.exit(left === 0 ? 0 : 1);
