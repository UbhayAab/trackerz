// Logs a meal the same way the capture pipeline does — raw_ingestion +
// ai_run + ai_action + food_log — so it appears in the additions feed, is
// undoable from the UI, and carries a real provenance trail instead of
// materialising as an orphan row.
//
// Macros come from lib/food-nutrition.mjs where the item is recognized; anything
// composed by hand is stated in the description so it can be corrected in a tap.
//
// Usage: node scripts/log-food.mjs            (dry run — prints what it would write)
//        node scripts/log-food.mjs --apply
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here — set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const APPLY = process.argv.includes("--apply");
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb"; // ubhayvatsaanand@gmail.com

// The two items the owner reported for 2026-07-22, in the order they said them.
const MEALS = [
  {
    text: "4 boiled eggs",
    description: "4 boiled eggs",
    occurred_at: "2026-07-22T22:30:00+05:30",
    meal_slot: "dinner",
    // Recognized by the lookup table -> authoritative, overrides any model guess.
    macros: null,
    confidence: 1,
  },
  {
    text: "Greek yogurt with blueberries and sugar",
    description: "Greek yogurt with blueberries and sugar (assumed 150g yogurt, ~1/2 cup blueberries, 2 tsp sugar)",
    occurred_at: "2026-07-22T22:45:00+05:30",
    meal_slot: "dinner",
    // Only the yogurt is in the table; blueberries and sugar are composed by
    // hand from standard portions, so the assumption is written into the
    // description and the confidence is lowered to match.
    macros: { calories_estimate: 165, protein_g: 15.6, carbs_g: 25, fat_g: 0.8 },
    confidence: 0.7,
  },
];

function macrosFor(meal) {
  if (meal.macros) return { ...meal.macros, source: "composed_manual" };
  const est = estimateNutrition(meal.text);
  if (!est.recognized) throw new Error(`not recognized and no manual macros: ${meal.text}`);
  return {
    calories_estimate: Math.round(est.totals.calories),
    protein_g: est.totals.protein_g,
    carbs_g: est.totals.carbs_g,
    fat_g: est.totals.fat_g,
    source: "lookup_table",
  };
}

const rows = MEALS.map((m) => ({ meal: m, macros: macrosFor(m) }));
for (const { meal, macros } of rows) {
  console.log(`${meal.occurred_at}  ${meal.meal_slot.padEnd(9)} ${String(macros.calories_estimate).padStart(4)} kcal  P${macros.protein_g} C${macros.carbs_g} F${macros.fat_g}  [${macros.source}]  ${meal.description}`);
}
if (!APPLY) {
  console.log("\ndry run — pass --apply to write");
  process.exit(0);
}

const client = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query("begin");
  for (const { meal, macros } of rows) {
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
