// One-off: log the owner's 2026-07-28 curd + whey meal through the same
// provenance path as scripts/log-food.mjs (raw_ingestion + ai_run + ai_action +
// food_log), so it shows in the additions feed and stays undoable from the UI.
//
// Usage: node scripts/log-food-2026-07-28.mjs            (dry run)
//        node scripts/log-food-2026-07-28.mjs --apply
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const APPLY = process.argv.includes("--apply");
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb"; // ubhayvatsaanand@gmail.com

// Composed by hand, because neither quantity is a lookup-table serving:
//   1 L curd  = 1000 g. lib/food-nutrition.mjs prices curd at 90 kcal / P5 C6 F5
//               per katori (~150 g), i.e. ~60 kcal / P3.3 C4 F3.3 per 100 g.
//               x10  -> 600 kcal, P33, C40, F33.
//   2 scoops whey = 50 g protein as stated by the owner (the table's generic
//               scoop is 24 g protein / 120 kcal; scaled to the stated 25 g per
//               scoop) -> 250 kcal, P50, C6, F3.
const MEALS = [
  {
    text: "1 litre curd and 2 scoops whey protein",
    description: "1 L curd + 2 scoops whey (50 g protein in 2 scoops)",
    occurred_at: "2026-07-28T13:30:00+05:30",
    meal_slot: "other",
    macros: { calories_estimate: 850, protein_g: 83, carbs_g: 46, fat_g: 36, source: "composed_manual" },
    confidence: 0.8,
  },
];

for (const m of MEALS) {
  const x = m.macros;
  console.log(`${m.occurred_at}  ${m.meal_slot.padEnd(9)} ${String(x.calories_estimate).padStart(4)} kcal  P${x.protein_g} C${x.carbs_g} F${x.fat_g}  [${x.source}]  ${m.description}`);
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
  for (const meal of MEALS) {
    const macros = meal.macros;
    const ing = await client.query(
      `insert into raw_ingestions (user_id, source_type, capture_mode, raw_text, occurred_at, status)
       values ($1, 'text', 'manual', $2, $3, 'processed') returning id`,
      [USER, meal.text, meal.occurred_at],
    );
    const ingestionId = ing.rows[0].id;

    const food = await client.query(
      `insert into food_logs
         (user_id, ingestion_id, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g, confidence, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [USER, ingestionId, meal.meal_slot, meal.description,
       macros.calories_estimate, macros.protein_g, macros.carbs_g, macros.fat_g,
       meal.confidence, meal.occurred_at],
    );
    const foodId = food.rows[0].id;

    const run = await client.query(
      `insert into ai_runs (user_id, ingestion_id, provider, model, purpose, status)
       values ($1,$2,'manual','none','manual_entry','succeeded') returning id`,
      [USER, ingestionId],
    );

    await client.query(
      `insert into ai_actions
         (user_id, ai_run_id, ingestion_id, tool_name, arguments, confidence, status, applied_record_table, applied_record_id, applied_at)
       values ($1,$2,$3,'create_food_log_candidate',$4,$5,'auto_applied','food_logs',$6, now())`,
      [USER, run.rows[0].id, ingestionId,
       JSON.stringify({
         meal_slot: meal.meal_slot, description: meal.description,
         calories_estimate: macros.calories_estimate, protein_g: macros.protein_g,
         carbs_g: macros.carbs_g, fat_g: macros.fat_g,
         occurred_at: meal.occurred_at, _macro_source: macros.source, _entered_by: "owner_request",
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
