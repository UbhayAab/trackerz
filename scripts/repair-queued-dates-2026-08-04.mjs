// Re-date the rows written by the queued-capture batch of 2026-06-28.
//
// Captures made while the agent was unreachable sat in raw_ingestions as 'queued'
// and were all processed together on 2026-06-28 07:18-07:20. Every undated event
// in them was stamped with the PROCESSING clock, so three days of meals and spends
// (2026-06-25 to 06-27) collapsed onto 06-28. The pipeline fix is `capturedAt` in
// supabase/functions/agent/index.ts; this re-dates the rows already written.
//
// The correction runs the SAME resolveOccurredAt the live path uses, with the same
// text, but anchored to the ingestion's real created_at instead of the processing
// clock. So "Had maggi yesterday night" captured 06-26 11:30 IST resolves to
// 06-25 21:00 IST, exactly as it would today.
//
// Only rows whose capture predates its ai_run are touched, and only when the new
// date differs. Every change is audit-logged with its before and after.
//
// Usage: node scripts/repair-queued-dates-2026-08-04.mjs [--apply]
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";
import { resolveOccurredAt } from "../lib/fan-out-expander.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");
const TABLES = [
  { name: "food_logs", col: "occurred_at", label: "description" },
  { name: "ledger_entries", col: "occurred_at", label: "merchant" },
  { name: "workout_logs", col: "occurred_at", label: "description" },
  { name: "sleep_sessions", col: "started_at", label: "note" },
];

async function main() {
  const db = await connectDb();
  let changed = 0, kept = 0;
  try {
    for (const t of TABLES) {
      const { rows } = await db.query(`
        select x.id, x.user_id, x.${t.col} as at, x.${t.label} as label,
               i.created_at as captured, i.raw_text
        from ${t.name} x
        join raw_ingestions i on i.id = x.ingestion_id
        join ai_runs r on r.ingestion_id = i.id
        where r.created_at::date > i.created_at::date      -- processed on a later day
          and x.${t.col} is not null
        order by i.created_at`);
      for (const r of rows) {
        const captured = new Date(r.captured).toISOString();
        const want = resolveOccurredAt(r.raw_text || "", captured);
        const wantDay = new Date(want).toISOString().slice(0, 10);
        const haveDay = new Date(r.at).toISOString().slice(0, 10);
        if (wantDay === haveDay) { kept++; continue; }
        changed++;
        console.log(`  ${APPLY ? "SET" : "would set"}  ${t.name.padEnd(15)} ${haveDay} -> ${wantDay}  (captured ${captured.slice(0, 10)})  ${String(r.label || "").replace(/\s+/g, " ").slice(0, 34)}`);
        console.log(`        "${String(r.raw_text || "").replace(/\s+/g, " ").slice(0, 76)}"`);
        if (!APPLY) continue;
        await db.query(
          `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
           values ($1, 'update', $2, $3, $4, $5, 'repair-queued-dates-2026-08-04')`,
          [r.user_id, t.name, r.id, JSON.stringify({ [t.col]: r.at }), JSON.stringify({ [t.col]: want })],
        );
        await db.query(`update ${t.name} set ${t.col} = $1 where id = $2`, [want, r.id]);
      }
    }
  } finally {
    await db.end();
  }
  console.log(`\n${changed} rows ${APPLY ? "re-dated" : "would change"}, ${kept} already on the right day.`);
  if (!APPLY) console.log("Dry run. Re-run with --apply to write.");
}

main().catch((err) => { console.error(err); process.exit(1); });
