// Backfill for ingestion bec702ca-223a-4c01-b539-99ebb3c9d748 (2026-07-28 06:29
// IST). The agent filed that capture as a diet NOTE instead of food logs, and
// the salvage net in fan-out-expander.mjs did not fire because none of the items
// appear in its FOOD_WORDS list. See the audit in the session notes.
//
// Written through the same provenance path as scripts/log-food.mjs, but reusing
// the ORIGINAL ingestion id so the meal stays attached to the capture the user
// actually made rather than materialising as a second, unrelated event.
//
// Usage: node scripts/log-food-2026-07-28b.mjs            (dry run)
//        node scripts/log-food-2026-07-28b.mjs --apply
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const APPLY = process.argv.includes("--apply");
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb"; // ubhayvatsaanand@gmail.com
const INGESTION = "bec702ca-223a-4c01-b539-99ebb3c9d748";

// Composed by hand - estimateNutrition() recognises none of these three items,
// and the one near-match it does hold ("cola", 140 kcal / 39 g carbs) is REGULAR
// cola, which would have charged 420 kcal and 117 g of carbs for drinks that
// contain neither.
//   Coke Zero 300 ml x3 -> ~0.3 kcal/100 ml -> ~3 kcal total, no macros.
//   Eat Better Co ragi chips, 55 g pack -> label-typical baked millet chips at
//   ~450 kcal/100 g -> ~248 kcal, P4.5 C33 F11 per pack, x2 packs.
const MEALS = [
  {
    description: "3x Coca-Cola Zero Sugar 300 ml + 2x Eat Better Co Ragi Chips 55 g (Achari Masti, Thai Chilli Tadka) - chips estimated from a typical baked-ragi label, ~450 kcal/100 g",
    occurred_at: "2026-07-28T06:29:15+05:30",
    meal_slot: "snack",
    macros: { calories_estimate: 499, protein_g: 9, carbs_g: 66, fat_g: 22, source: "composed_manual" },
    confidence: 0.65,
  },
];

for (const m of MEALS) {
  const x = m.macros;
  console.log(`${m.occurred_at}  ${m.meal_slot.padEnd(9)} ${String(x.calories_estimate).padStart(4)} kcal  P${x.protein_g} C${x.carbs_g} F${x.fat_g}  [${x.source}]`);
  console.log(`  ${m.description}`);
}
if (!APPLY) {
  console.log("\ndry run - pass --apply to write");
  process.exit(0);
}

const client = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query("begin");

  // Guard: never write this twice.
  const existing = await client.query(
    `select id from food_logs where ingestion_id = $1`, [INGESTION],
  );
  if (existing.rows.length) {
    throw new Error(`ingestion ${INGESTION} already has ${existing.rows.length} food_log(s) - nothing to backfill`);
  }

  for (const meal of MEALS) {
    const macros = meal.macros;
    const food = await client.query(
      `insert into food_logs
         (user_id, ingestion_id, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g, confidence, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [USER, INGESTION, meal.meal_slot, meal.description,
       macros.calories_estimate, macros.protein_g, macros.carbs_g, macros.fat_g,
       meal.confidence, meal.occurred_at],
    );
    const foodId = food.rows[0].id;

    const run = await client.query(
      `insert into ai_runs (user_id, ingestion_id, provider, model, purpose, status)
       values ($1,$2,'manual','none','manual_entry','succeeded') returning id`,
      [USER, INGESTION],
    );

    await client.query(
      `insert into ai_actions
         (user_id, ai_run_id, ingestion_id, tool_name, arguments, confidence, status, applied_record_table, applied_record_id, applied_at)
       values ($1,$2,$3,'create_food_log_candidate',$4,$5,'auto_applied','food_logs',$6, now())`,
      [USER, run.rows[0].id, INGESTION,
       JSON.stringify({
         meal_slot: meal.meal_slot, description: meal.description,
         calories_estimate: macros.calories_estimate, protein_g: macros.protein_g,
         carbs_g: macros.carbs_g, fat_g: macros.fat_g,
         occurred_at: meal.occurred_at, _macro_source: macros.source,
         _entered_by: "owner_request", _backfill_of: "note 7e04b30d-40a6-4a93-83ea-d915e054d5af",
       }),
       meal.confidence, foodId],
    );
    console.log(`wrote food_log ${foodId}`);
  }
  await client.query("commit");
  console.log("committed.");
} catch (err) {
  await client.query("rollback");
  console.error("rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
