// One-off repair for the rows the 2026-08-04 classification audit found.
//
// The three defects that produced them are fixed in code (lib/fan-out-expander.mjs
// month boundary + money-trail guard, src/agent/tool-schemas.js required-field
// repair, both mirrored into supabase/functions/agent/index.ts). These are the
// rows already written before the fix. Nothing here is a judgement call about
// what he ate or spent - every deletion is either a byte-identical re-log, a
// subset already contained in a kept row, or a number the app read off something
// that was not money.
//
// Every delete is written to audit_log with the full row in `before`, so it can be
// reconstructed.
//
// Usage: node scripts/repair-misclassified-2026-08-04.mjs [--apply]
//        (defaults to a dry run that writes nothing)
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

// Each entry names the row, the table, and WHY it goes - checked against the
// capture and the tool call that produced it before being listed here.
const DELETIONS = [
  {
    table: "food_logs",
    id: "9cfd77cb-8fb5-4e96-a36e-b034c4f9509a",
    why: '"2 Margherita" parsed as 2 March: 2026-08-02 pizza filed under 2026-03-02. No calories, description is the raw capture. Superseded by the 2,475 kcal row on 08-02.',
  },
  {
    table: "food_logs",
    id: "2be6c158-3976-4d05-9231-9029db1e522e",
    why: "Byte-identical duplicate of the row above, same capture, same March misdate.",
  },
  {
    table: "food_logs",
    id: "bf259127-57f0-4f7e-9c84-31626f0106a9",
    why: "Same March misdate. 325 kcal of paneer + mozzarella that is already inside the 2,475 kcal total kept on 08-02, so keeping it double-counts the toppings.",
  },
  {
    table: "ledger_entries",
    id: "ec0ad4ec-7404-41ee-b377-daf1a06bd5b6",
    why: 'Rs 5.50 read off "METs: 5.5" at the end of a cardio machine screenshot. Not a purchase; the description is the whole treadmill display.',
  },
  {
    table: "workout_logs",
    id: "8640009f-2feb-43f8-9139-505ecfb874fc",
    why: "Second log of the SAME cardio session (identical readout: 21:26, 216 kcal, 2.3 km) from a re-shared screenshot 8h later. This copy is the salvage fallback: raw OCR as description, no duration, no distance, no calories. The 01:08 row keeps all of them.",
  },
  {
    table: "food_logs",
    id: "ab075812-7907-4520-b94a-6ff0dc00616d",
    why: 'Popcorn logged twice on 08-01. The journal capture said "already logged"; the guard that now suppresses this landed 46 min later. The kept 350 kcal row is the direct capture and carries the detail ("ate 2/5 of the tub").',
  },
  {
    table: "food_logs",
    id: "1e9a05ca-a3d5-4230-8835-19673504d3b3",
    why: "Burrito logged twice on 08-01, same journal capture. The kept 1,500 kcal row is the itemised California Burrito from the direct capture.",
  },
  {
    table: "ledger_entries",
    id: "22880417-3af2-4185-b12f-37eb12c0d5c8",
    why: 'Rs 15 "Legend / Burrito" from the garbled voice line "eat in legend on find rupees store 15". Rs 15 is not a burrito price and the model itself only gave it 0.60. Removing a wrong number rather than leaving it in the spend totals - the meal itself is still logged.',
  },
];

// Deliberately NOT deleted, so the reasoning is on the record:
//   ledger_entries Rs 484 "Movie tickets" (2026-08-01). The same journal said it
//   was already logged, but no other 484 row exists anywhere in the ledger, and
//   the amount and story are specific and plausible. Deleting it would drop real
//   spending on the strength of a transcription. Left in place.

async function main() {
  const db = await connectDb();
  let removed = 0;
  try {
    for (const d of DELETIONS) {
      const { rows } = await db.query(`select * from ${d.table} where id = $1`, [d.id]);
      if (!rows.length) {
        console.log(`  skip  ${d.table} ${d.id.slice(0, 8)} - already gone`);
        continue;
      }
      const row = rows[0];
      const label = row.description || row.merchant || row.meal_name || "(no label)";
      console.log(`  ${APPLY ? "DELETE" : "would delete"}  ${d.table} ${d.id.slice(0, 8)}  ${String(label).replace(/\s+/g, " ").slice(0, 55)}`);
      console.log(`          ${d.why}`);
      if (!APPLY) continue;
      await db.query(
        `insert into audit_log (user_id, action, target_table, target_id, before, source)
         values ($1, 'delete', $2, $3, $4, 'repair-misclassified-2026-08-04')`,
        [row.user_id, d.table, d.id, JSON.stringify(row)],
      );
      await db.query(`delete from ${d.table} where id = $1`, [d.id]);
      removed += 1;
    }
  } finally {
    await db.end();
  }
  console.log(APPLY
    ? `\nRemoved ${removed} rows. Each one's full contents are in audit_log (source='repair-misclassified-2026-08-04').`
    : `\nDry run. ${DELETIONS.length} rows listed. Re-run with --apply to write.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
