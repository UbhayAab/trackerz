// WHICH WORDS THE APP DOES NOT KNOW, ranked by how often they cost you a number.
//
// lib/food-nutrition.mjs is the app's only food vocabulary, and its override is
// ALL-OR-NOTHING: one unrecognised token drops `recognized` to false and the
// model's guess wins for the WHOLE meal, even when the other 70% was priced
// exactly. That is how "70g soya bean, and 50g oats" was logged at 480 kcal /
// 32 g protein instead of 308 / 18.9 - the alias list had "soya beans" but not
// "soya bean", so the token "bean" was unknown.
//
// The failure is silent by construction: a wrong number looks exactly like a
// right one. This script is the only way to see the gap, so run it after any
// complaint that the calculations are off.
//
//   node scripts/food-vocab-audit.mjs            every food row ever
//   node scripts/food-vocab-audit.mjs --days 14  just the recent ones
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

loadEnv({ path: ".env.local" });
const args = process.argv.slice(2);
const days = Number((args.find((a) => a.startsWith("--days")) || "").split("=")[1] || args[args.indexOf("--days") + 1]) || null;

const url = process.env.SUPABASE_DB_URL || process.env.SUPABASE_DB_URL_POOLER;
if (!url) { console.error("no SUPABASE_DB_URL in .env.local"); process.exit(2); }
const client = new pg.Client({ connectionString: url.replace(/\?.*$/, ""), ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `select description, meal_name, calories_estimate, protein_g, occurred_at
     from food_logs
    where description is not null and description <> ''
      ${days ? `and occurred_at > now() - interval '${days} days'` : ""}
    order by occurred_at desc`,
);
await client.end();

const unknownFreq = new Map();
let recognised = 0, missed = 0;
const disagreements = [];

for (const r of rows) {
    // DESCRIPTION ONLY. meal_name is a label the model wrote ("Protein milk
  // shake"), not an ingredient list, and concatenating the two counts the same
  // food twice: this script once proposed 91 g of protein for a 56 g meal because
  // the name matched a food the description had already listed.
  const text = String(r.description || "");
  const est = estimateNutrition(text);
  if (est.recognized) {
    recognised++;
    // Even a recognised row can disagree with what was STORED, because the row
    // may predate the table entry that would have priced it.
    const storedP = Number(r.protein_g);
    if (Number.isFinite(storedP) && Math.abs(storedP - est.totals.protein_g) > 3) {
      disagreements.push({ text: text.slice(0, 48), stored: storedP, table: est.totals.protein_g, at: String(r.occurred_at).slice(0, 10) });
    }
    continue;
  }
  missed++;
  for (const w of est.unknown) unknownFreq.set(w, (unknownFreq.get(w) || 0) + 1);
}

const total = rows.length || 1;
console.log(`\n${rows.length} food rows${days ? ` in the last ${days} days` : ""}`);
console.log(`  priced by the table : ${recognised} (${Math.round((recognised / total) * 100)}%)`);
console.log(`  left to the model   : ${missed} (${Math.round((missed / total) * 100)}%)\n`);

const ranked = [...unknownFreq.entries()].sort((a, b) => b[1] - a[1]);
if (ranked.length) {
  console.log("WORDS THE TABLE DOES NOT KNOW (add these to lib/food-nutrition.mjs):");
  for (const [w, n] of ranked.slice(0, 40)) console.log(`  ${String(n).padStart(3)}x  ${w}`);
} else {
  console.log("Every food word in the history is in the table.");
}

if (disagreements.length) {
  console.log(`\nSTORED NUMBERS THAT DISAGREE WITH THE TABLE BY >3 g PROTEIN (${disagreements.length}):`);
  console.log("These rows are priceable NOW but were written before the entry existed.");
  for (const d of disagreements.slice(0, 20)) {
    console.log(`  ${d.at}  ${d.text.padEnd(50)} stored ${d.stored}g -> table ${d.table}g`);
  }
}
console.log("");
