// Remove the food rows that double-count a single meal.
//
// Found by clustering every food row against every other within 6h on a
// normalised description, then reading each cluster against its capture text.
// Only clusters where ONE real meal produced MORE THAN ONE row are listed. The
// 2026-06-29 idli pair is deliberately NOT here: those are two separate captures
// 5.5h apart (22:10 IST dinner and a 03:48 IST late-night plate), which is a
// person eating twice, not the app logging once twice.
//
// Every delete is audit-logged with the full row.
//
// Usage: node scripts/repair-duplicate-meals-2026-08-04.mjs [--apply]
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

const DELETIONS = [
  // 2026-06-25: one Rs 120 mushroom sandwich + rose milk, described three times
  // in 2 hours while the agent was offline, and queued into three 550 kcal rows -
  // 1,650 kcal booked for a 550 kcal meal. The money side landed only once, which
  // is why the day looked fine on the spend page and wrong on the diet page.
  // Kept: 413a8316, the itemised row, and the one the Rs 120 ledger entry pairs with.
  { table: "food_logs", id: "b8c44123-ab6d-4e32-b995-2c9ff882b4e7", why: '550 kcal re-log of the same sandwich ("I\'m just spent 120 on Rose milk and mushroom sandwich")' },
  { table: "food_logs", id: "23cd32fe-ab20-491a-a62e-f768767d1e3b", why: '550 kcal re-log of the same sandwich ("Paid 120 for rose milk and mushroom sandwich")' },

  // 2026-07-09: one snack captured twice 39 seconds apart produced THREE rows -
  // 490 + 350 + 430 = 1,270 kcal for a ~430 kcal snack. Two of them came from the
  // SAME ingestion, so a single capture wrote the meal twice. This incident is
  // already documented in src/duplicates/expense-duplicates.js as the shape
  // pairwise scoring cannot see. Kept: 576accbb, the first capture's row.
  { table: "food_logs", id: "db5d8841-608e-4bf6-b5c4-46756f876517", why: "second food row from the SAME ingestion as 576accbb - one capture, two meals written" },
  { table: "food_logs", id: "465833e9-fc39-4326-8b45-12540d36d84e", why: "the 39-second retry of the same snack, logged again rather than matched" },
];

async function main() {
  const db = await connectDb();
  let removed = 0;
  try {
    for (const d of DELETIONS) {
      const { rows } = await db.query(`select * from ${d.table} where id = $1`, [d.id]);
      if (!rows.length) { console.log(`  skip  ${d.id.slice(0, 8)} - already gone`); continue; }
      const row = rows[0];
      console.log(`  ${APPLY ? "DELETE" : "would delete"}  ${d.table} ${d.id.slice(0, 8)}  ${row.calories_estimate} kcal  ${String(row.description || "").replace(/\s+/g, " ").slice(0, 42)}`);
      console.log(`          ${d.why}`);
      if (!APPLY) continue;
      await db.query(
        `insert into audit_log (user_id, action, target_table, target_id, before, source)
         values ($1, 'delete', $2, $3, $4, 'repair-duplicate-meals-2026-08-04')`,
        [row.user_id, d.table, d.id, JSON.stringify(row)],
      );
      await db.query(`delete from ${d.table} where id = $1`, [d.id]);
      removed++;
    }
  } finally {
    await db.end();
  }
  console.log(APPLY
    ? `\nRemoved ${removed} rows. Full contents in audit_log (source='repair-duplicate-meals-2026-08-04').`
    : `\nDry run. Re-run with --apply to write.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
