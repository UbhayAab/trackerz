// Backfill the meals of Fri 21, Sat 22 and Sun 23 August 2026, as dictated by
// the owner, plus the three days he answered with "I did not go to the gym".
//
// Same write shape as scripts/log-food.mjs - raw_ingestion + ai_run + ai_action
// + the domain row - so every row lands in the additions feed, is undoable from
// the UI in one tap, and carries a provenance trail instead of materialising as
// an orphan nobody can explain later.
//
// Macros are NOT composed here. Every line is priced by lib/food-nutrition.mjs,
// which learned the roll shop in the same change that added this script; if a
// line ever stops being recognized the script refuses to write it rather than
// substituting a guess. That is the whole reason the vocabulary was fixed first:
// before it, "2 paneer rolls and 1 double egg roll" priced at 602 kcal / 42.3 g
// protein - two fried wraps missing, and 200 g of loose paneer invented in their
// place.
//
// WHAT IS ASSUMED, because it was not said and must not be silently invented:
//   - "pani roll" is read as PANEER roll (voice capture; there is no such dish
//     as a pani roll, and "pani" alone is the stopword for water).
//   - Only Friday's meal carried a slot ("in dinner"). Every other row is filed
//     as `other` rather than guessed into lunch or dinner - a slot is a claim
//     about when he ate, and he only made that claim once.
//   - Clock times for `other` rows are placeholders inside the right DAY. The
//     DATE is the fact; the hour is not. They are spread so the feed keeps the
//     order he said them in.
//
// Usage: node scripts/log-food-2026-08-23.mjs            (dry run - prints, writes nothing)
//        node scripts/log-food-2026-08-23.mjs --apply
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");
const USER = "548339a8-6d61-4bd9-bc7e-9768be01e4eb"; // ubhayvatsaanand@gmail.com

const MEALS = [
  {
    text: "2 paneer rolls and 1 double egg roll",
    description: "2 paneer rolls and 1 double egg roll",
    occurred_at: "2026-08-21T21:00:00+05:30",
    meal_slot: "dinner",
    note: "Friday dinner - the meal he said went unlogged.",
  },
  {
    text: "2 paneer rolls and 1 double egg roll",
    description: "2 paneer rolls and 1 double egg roll (the only food of the day)",
    occurred_at: "2026-08-22T13:00:00+05:30",
    meal_slot: "other",
    note: "Saturday, entire day.",
  },
  {
    text: "1 triple egg roll, 1 aloo roll and 1 paneer roll",
    description: "1 triple egg roll, 1 aloo roll and 1 paneer roll",
    occurred_at: "2026-08-23T13:00:00+05:30",
    meal_slot: "other",
    note: "Sunday rolls.",
  },
  {
    text: "2 packs maggi",
    description: "2 packs of Maggi",
    occurred_at: "2026-08-23T17:00:00+05:30",
    meal_slot: "other",
    note: "Sunday - \"two bricks of Maggi\".",
  },
  {
    text: "tomato rice",
    description: "Tomato rice",
    occurred_at: "2026-08-23T20:00:00+05:30",
    meal_slot: "other",
    note: "Sunday.",
  },
];

// He answered all three days at once: "I did not go to the gym." An answered day
// is NOT a missing day, and the difference is load-bearing - a `skipped` row
// stops the morning brief reporting a session he denied, without counting as
// training. See lib/negation.mjs and the workout_logs.status comment in schema.
const SKIPPED_GYM = [
  "2026-08-21T20:00:00+05:30",
  "2026-08-22T20:00:00+05:30",
  "2026-08-23T20:00:00+05:30",
];

function macrosFor(meal) {
  const est = estimateNutrition(meal.text);
  if (!est.recognized) {
    throw new Error(
      `"${meal.text}" is no longer priced by the table (unknown: ${est.unknown.join(", ")}). ` +
      `Refusing to write a guess - fix lib/food-nutrition.mjs instead.`,
    );
  }
  return {
    calories_estimate: Math.round(est.totals.calories),
    protein_g: est.totals.protein_g,
    carbs_g: est.totals.carbs_g,
    fat_g: est.totals.fat_g,
    items: est.items.map((i) => `${i.key} x${i.qty}`).join(", "),
  };
}

const rows = MEALS.map((m) => ({ meal: m, macros: macrosFor(m) }));

const day = (iso) => iso.slice(0, 10);
let totCal = 0;
let curDay = null;
for (const { meal, macros } of rows) {
  if (day(meal.occurred_at) !== curDay) {
    curDay = day(meal.occurred_at);
    console.log(`\n${curDay}`);
  }
  totCal += macros.calories_estimate;
  console.log(
    `  ${meal.occurred_at.slice(11, 16)}  ${meal.meal_slot.padEnd(7)} ` +
    `${String(macros.calories_estimate).padStart(4)} kcal  P${String(macros.protein_g).padStart(5)} ` +
    `C${String(macros.carbs_g).padStart(5)} F${String(macros.fat_g).padStart(5)}  ${meal.description}`,
  );
  console.log(`          priced as: ${macros.items}`);
}
console.log(`\n${rows.length} meals, ${totCal} kcal total`);
console.log(`${SKIPPED_GYM.length} gym days marked skipped: ${SKIPPED_GYM.map(day).join(", ")}`);

if (!APPLY) {
  console.log("\ndry run - pass --apply to write");
  process.exit(0);
}

const client = await connectDb();
try {
  await client.query("begin");

  for (const { meal, macros } of rows) {
    // Idempotent by (user, description, occurred_at). Re-running this script was
    // otherwise a second copy of every meal, and duplicate meals have needed a
    // repair script here before (scripts/repair-duplicate-meals-2026-08-04.mjs).
    const dupe = await client.query(
      `select id from food_logs
        where user_id = $1 and description = $2 and occurred_at = $3 and deleted_at is null`,
      [USER, meal.description, meal.occurred_at],
    );
    if (dupe.rowCount) {
      console.log(`skip (already logged) ${meal.occurred_at}  ${meal.description}`);
      continue;
    }

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
       1, meal.occurred_at],
    );

    const run = await client.query(
      `insert into ai_runs (user_id, ingestion_id, provider, model, purpose, status)
       values ($1,$2,'manual','none','manual_entry','succeeded') returning id`,
      [USER, ingestionId],
    );

    await client.query(
      `insert into ai_actions
         (user_id, ai_run_id, ingestion_id, tool_name, arguments, confidence, status, applied_record_table, applied_record_id, applied_at)
       values ($1,$2,$3,'create_food_log_candidate',$4,1,'auto_applied','food_logs',$5, now())`,
      [USER, run.rows[0].id, ingestionId,
       JSON.stringify({
         meal_slot: meal.meal_slot, description: meal.description,
         calories_estimate: macros.calories_estimate, protein_g: macros.protein_g,
         carbs_g: macros.carbs_g, fat_g: macros.fat_g,
         occurred_at: meal.occurred_at, _macro_source: "lookup_table",
         _entered_by: "owner_dictated_backfill",
       }),
       food.rows[0].id],
    );
    console.log(`wrote food_log ${food.rows[0].id}  ${meal.description}`);
  }

  for (const occurredAt of SKIPPED_GYM) {
    const dupe = await client.query(
      `select id from workout_logs
        where user_id = $1 and occurred_at::date = $2::date and deleted_at is null`,
      [USER, occurredAt],
    );
    if (dupe.rowCount) {
      console.log(`skip (workout row already exists) ${day(occurredAt)}`);
      continue;
    }
    const ing = await client.query(
      `insert into raw_ingestions (user_id, source_type, capture_mode, raw_text, occurred_at, status)
       values ($1, 'text', 'manual', 'no gym', $2, 'processed') returning id`,
      [USER, occurredAt],
    );
    const w = await client.query(
      `insert into workout_logs (user_id, ingestion_id, description, status, occurred_at)
       values ($1,$2,'No gym', 'skipped', $3) returning id`,
      [USER, ing.rows[0].id, occurredAt],
    );
    console.log(`wrote workout_log ${w.rows[0].id} (skipped)  ${day(occurredAt)}`);
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
