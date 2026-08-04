// Backfill meal_slot on the food rows that were bucketed off the UTC hour.
//
// mealSlotFromTime read the hour TEXTUALLY out of the ISO string, which is right
// only when the string carries +05:30 - and the model routinely emits Z. On top of
// that, the prompt never told the model to derive the slot from the clock, so it
// guessed from the food ("eggs -> breakfast"). Measured across all 103 real
// captures: 31 of 62 stored food rows (50%) disagreed with their own IST hour.
//
// The code fix is resolveMealSlot in lib/fan-out-expander.mjs, mirrored into the
// agent edge function and applied on the write path. This backfills history using
// the SAME function, so the stored rows and the live pipeline cannot disagree.
//
// Authority order (identical to the live path):
//   1. a slot the capture NAMED  - "had idli for dinner" beats a 01:29 clock.
//   2. the IST clock.
//   3. the existing value        - only if occurred_at is unusable.
//
// Rows with no linked capture (quick-add chips) still get the clock, since there
// is no capture text to consult. Every change is written to audit_log.
//
// Usage: node scripts/repair-meal-slots-2026-08-04.mjs [--apply]
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";
import { resolveMealSlot, istHourOf } from "../lib/fan-out-expander.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = await connectDb();
  let changed = 0, unchanged = 0;
  try {
    const { rows } = await db.query(`
      select f.id, f.user_id, f.occurred_at, f.meal_slot, f.description, f.calories_estimate, i.raw_text
      from food_logs f left join raw_ingestions i on i.id = f.ingestion_id
      order by f.occurred_at`);
    for (const r of rows) {
      if (!r.occurred_at) { unchanged++; continue; }
      const want = resolveMealSlot(r.meal_slot, r.occurred_at.toISOString(), r.raw_text || "", r.calories_estimate);
      if (want === r.meal_slot) { unchanged++; continue; }
      changed++;
      const hour = String(istHourOf(r.occurred_at.toISOString())).padStart(2, "0");
      console.log(`  ${APPLY ? "SET" : "would set"}  ${r.occurred_at.toISOString().slice(0, 16)}  ${hour}:xx IST  ${String(r.meal_slot).padEnd(9)} -> ${String(want).padEnd(9)}  ${String(r.description || "").replace(/\s+/g, " ").slice(0, 40)}`);
      if (!APPLY) continue;
      await db.query(
        `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
         values ($1, 'update', 'food_logs', $2, $3, $4, 'repair-meal-slots-2026-08-04')`,
        [r.user_id, r.id, JSON.stringify({ meal_slot: r.meal_slot }), JSON.stringify({ meal_slot: want })],
      );
      await db.query(`update food_logs set meal_slot = $1 where id = $2`, [want, r.id]);
    }
  } finally {
    await db.end();
  }
  console.log(`\n${changed} rows ${APPLY ? "corrected" : "would change"}, ${unchanged} already right.`);
  if (!APPLY) console.log("Dry run. Re-run with --apply to write.");
}

main().catch((err) => { console.error(err); process.exit(1); });
