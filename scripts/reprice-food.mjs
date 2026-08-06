// REPRICE HISTORICAL FOOD ROWS against the current table.
//
// The food table is the app's authority, but a row is priced ONCE, at capture
// time, by whatever vocabulary existed then. Every word added to
// lib/food-nutrition.mjs therefore leaves a tail of rows that a model guessed
// and the table can now answer exactly. Measured on 2026-08-06, adding "whey
// protein", "soya bean", "aloo bhujia" and the stopword "whole" moved table
// coverage from 42% to 73% - and every row in that gap had been carrying a
// guess into the day's totals, the weekly review and the pattern engine.
//
// Dry by default. It NEVER touches a row the table cannot fully price, and it
// writes an audit_log entry for every change so the whole pass is reversible.
//
//   node scripts/reprice-food.mjs                 show what would change
//   node scripts/reprice-food.mjs --apply         write it
//   node scripts/reprice-food.mjs --min-protein 3 only sizeable disagreements
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

loadEnv({ path: ".env.local" });
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
// indexOf returns -1 when the flag is absent, and args[-1 + 1] is args[0] - so
// running this with any OTHER flag made MIN_P = Number("--apply") = NaN, every
// "dp < NaN" comparison false, and the protein filter silently stopped filtering.
// It reviewed 15 rows in the dry run and then wrote 57. Parse the flag properly.
const mpIdx = args.indexOf("--min-protein");
const mpRaw = mpIdx >= 0 ? args[mpIdx + 1] : null;
// Number(null) is 0, not NaN, so an isFinite check on an ABSENT flag reads as a
// deliberate zero and turns the filter off entirely. Two different wrong answers
// from the same three lines - test the flag's presence, not its coercion.
const MIN_P = mpRaw == null || !Number.isFinite(Number(mpRaw)) ? 2 : Number(mpRaw);

const url = process.env.SUPABASE_DB_URL || process.env.SUPABASE_DB_URL_POOLER;
const client = new pg.Client({ connectionString: url.replace(/\?.*$/, ""), ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `select id, user_id, description, meal_name, calories_estimate, protein_g, carbs_g, fat_g, occurred_at
     from food_logs where description is not null and description <> '' order by occurred_at`,
);

const changes = [];
for (const r of rows) {
      // DESCRIPTION ONLY - see the note in scripts/food-vocab-audit.mjs. Adding
    // meal_name double-counts any food the label repeats.
    const est = estimateNutrition(String(r.description || ""));
  // Only a FULLY priced row is touched. A partial match would replace a model
  // guess with a smaller model guess, which is not an improvement.
  if (!est.recognized) continue;
  const dP = Math.abs(Number(r.protein_g) - est.totals.protein_g);
  const dC = Math.abs(Number(r.calories_estimate) - est.totals.calories);
  if (dP < MIN_P && dC < 40) continue;
  changes.push({ r, t: est.totals, dP: Number(dP.toFixed(1)), dC });
}

console.log(`\n${rows.length} rows scanned, ${changes.length} disagree with the table\n`);
for (const c of changes) {
  const d = String(c.r.occurred_at).slice(0, 10);
  console.log(`${d}  ${String(c.r.description).slice(0, 44).padEnd(46)}`);
  console.log(`            stored ${String(c.r.calories_estimate).padStart(4)} kcal / ${String(c.r.protein_g).padStart(5)} g P`);
  console.log(`            table  ${String(c.t.calories).padStart(4)} kcal / ${String(c.t.protein_g).padStart(5)} g P   (${c.dC} kcal, ${c.dP} g off)`);
}

if (!APPLY) { console.log(`\nDry run. Re-run with --apply to write these ${changes.length} corrections.\n`); await client.end(); process.exit(0); }

let done = 0;
for (const c of changes) {
  await client.query(
    `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
     values ($1,'reprice_food','food_logs',$2,$3,$4,'script')`,
    [c.r.user_id, c.r.id,
      JSON.stringify({ calories_estimate: c.r.calories_estimate, protein_g: c.r.protein_g, carbs_g: c.r.carbs_g, fat_g: c.r.fat_g }),
      JSON.stringify(c.t)],
  );
  await client.query(
    `update food_logs set calories_estimate=$1, protein_g=$2, carbs_g=$3, fat_g=$4 where id=$5`,
    [c.t.calories, c.t.protein_g, c.t.carbs_g, c.t.fat_g, c.r.id],
  );
  done++;
}
console.log(`\napplied ${done} corrections, each with an audit_log row.\n`);
await client.end();
