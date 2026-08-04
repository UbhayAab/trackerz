// Remove the meal fabricated from a note ABOUT meals.
//
// The 2026-08-04 11:15 UTC capture read "When you see me eating 6 boiled eggs
// daily. Why not add it in the json structure... This is a note. For claude to
// see later." It correctly produced a note and a remember_fact - and then
// deterministic salvage also wrote a 432 kcal / 37.8 g food row whose description
// is the note text itself. Nothing was eaten. Talking about eating is not eating.
//
// The pipeline fix is isAboutTheApp in lib/fan-out-expander.mjs, mirrored into the
// agent edge function; it flags 1 of 109 real captures and this is that one.
//
// Usage: node scripts/repair-meta-note-meal-2026-08-04.mjs [--apply]
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

const ID = "99c3430d-544c-4c9c-a7f6-ac8c8a93aa42";

async function main() {
  const db = await connectDb();
  try {
    const { rows } = await db.query("select * from food_logs where id = $1", [ID]);
    if (!rows.length) { console.log("  already gone"); return; }
    const row = rows[0];
    console.log(`  ${APPLY ? "DELETE" : "would delete"}  food_logs ${ID.slice(0, 8)}  ${row.calories_estimate} kcal / ${row.protein_g} g protein`);
    console.log(`          description is the note text: "${String(row.description).replace(/\s+/g, " ").slice(0, 70)}"`);
    if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); return; }
    await db.query(
      `insert into audit_log (user_id, action, target_table, target_id, before, source)
       values ($1, 'delete', 'food_logs', $2, $3, 'repair-meta-note-meal-2026-08-04')`,
      [row.user_id, ID, JSON.stringify(row)],
    );
    await db.query("delete from food_logs where id = $1", [ID]);
    console.log("\nRemoved. Full contents in audit_log (source='repair-meta-note-meal-2026-08-04').");
  } finally {
    await db.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
