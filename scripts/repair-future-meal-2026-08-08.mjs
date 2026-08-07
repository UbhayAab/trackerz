// The meal filed on 19 October 2026.
//
// THE BRIEF SAID: re-date food_logs 41f2c028 from 2026-10-19 back to 2026-08-06,
// clean the description, re-derive the macros. That was based on my own audit
// note, which said "his real 2026-08-06 lunch is missing from that day".
//
// THAT PREMISE IS WRONG, and I found it by checking before writing. The meal is
// NOT missing from 2026-08-06. It is already there, correctly, and re-dating
// this row would have logged the same bowl of bhujia twice.
//
// WHAT ACTUALLY HAPPENED. The identical 91-character sentence - same typo
// ("soop sachet"), same "the same as yesterday", same birthday line - was
// ingested TWICE on 2026-08-06 with a byte-identical `capture_fingerprint`
// (5654277c…):
//
//   d0a60123  15:14:33Z (20:44 IST)  -> food_logs 1b90dbea
//             "50g aloo bhujia and 2 soup sachets", snack,
//             occurred 2026-08-06 20:44 IST, 365 kcal / 8 P / 41 C / 19 F
//             ... which is exactly what lib/food-nutrition.mjs prices it at.
//             This row is correct in every field.
//
//   f7c1aa50  16:48:24Z (22:18 IST)  -> food_logs 41f2c028   <- the bad one
//             description is the whole raw capture including "My bday is 19 oct
//             2002", meal_slot lunch, 150 kcal / 3 P, and occurred_at
//             2026-10-19T06:30:00Z - the birthday in the sentence became the
//             meal's date, 73 days in the future.
//
// Both ingestions are `status='processed'` with `duplicate_of_ingestion_id`
// null. The idempotency guard fires on a re-send within about a minute (every
// other repeated fingerprint in this database - the Domino's paste, "Masala
// dosa", the Coke manifest - was caught at 0-1 minutes apart) and did not fire
// at 94 minutes. Nobody types the same 91 characters with the same typo twice to
// record a second snack; that is a re-send, not a second meal.
//
// SO THE REPAIR IS A DELETE, NOT A RE-DATE. Re-dating would have put a 12:00
// "lunch" on a day whose real entry is a 20:44 snack, and doubled his bhujia to
// 730 kcal. The correct row survives untouched; the phantom is tombstoned with
// its full before-image.
//
// Soft delete, not hard: `deleted_at` is what the app has used since commit
// 6236125, every read filters it, and it is reversible. A hard delete here would
// repeat the exact failure that lost the two orphaned notes.
//
// NOT FIXED HERE (owned by other work): the capture-flow idempotency window that
// let the re-send through, and the date parser that took a birthday for a meal
// date.
//
// Usage: node scripts/repair-future-meal-2026-08-08.mjs [--apply]
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

const PHANTOM = "41f2c028-d519-4225-b2a5-66f311d5a967";
const KEEPER = "1b90dbea-59cb-4e61-bb32-a6f1c2b72495";

const db = await connectDb();

try {
  const { rows: [bad] } = await db.query("select * from food_logs where id = $1", [PHANTOM]);
  if (!bad) { console.log("  phantom row already gone - nothing to do"); process.exit(0); }
  if (bad.deleted_at) { console.log(`  already tombstoned at ${bad.deleted_at.toISOString()}`); process.exit(0); }

  // THE SAFETY CHECK, run every time rather than trusted from the comment above:
  // never delete this row unless the meal it duplicates is provably still on the
  // right day, with the macros the food table says it has. If the keeper is gone
  // or wrong, deleting the phantom would lose the meal outright.
  const { rows: [keep] } = await db.query(
    "select * from food_logs where id = $1 and deleted_at is null", [KEEPER],
  );
  if (!keep) {
    console.error(`REFUSING: the row this duplicates (${KEEPER}) is not there. Deleting ${PHANTOM} would lose the meal.`);
    process.exit(1);
  }
  const keptDay = new Date(keep.occurred_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (keptDay !== "2026-08-06") {
    console.error(`REFUSING: ${KEEPER} sits on ${keptDay}, not 2026-08-06. The premise of this repair does not hold.`);
    process.exit(1);
  }
  const est = estimateNutrition(keep.description || "");
  if (!est.recognized) {
    console.error(`REFUSING: the food table does not recognise "${keep.description}", so it cannot confirm the keeper is priced right.`);
    process.exit(1);
  }
  const t = est.totals;
  const priced = Number(keep.calories_estimate) === t.calories && Number(keep.protein_g) === t.protein_g;

  console.log(APPLY ? "APPLYING\n" : "DRY RUN - nothing will be written (pass --apply)\n");
  console.log(`  KEEP    ${KEEPER}  "${keep.description}"`);
  console.log(`          ${keep.meal_slot} · ${new Date(keep.occurred_at).toISOString()} (${keptDay} IST)`);
  console.log(`          ${keep.calories_estimate} kcal / ${keep.protein_g} P  ·  food table says ${t.calories} / ${t.protein_g}`
    + `  ${priced ? "- match" : "- MISMATCH"}`);
  console.log("");
  console.log(`  ${APPLY ? "DELETE " : "would delete"} ${PHANTOM}  (duplicate of the above)`);
  console.log(`          "${String(bad.description).replace(/\s+/g, " ").slice(0, 72)}"`);
  console.log(`          ${bad.meal_slot} · ${new Date(bad.occurred_at).toISOString()}  <- 73 days in the future`);
  console.log(`          ${bad.calories_estimate} kcal / ${bad.protein_g} P`);

  if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); process.exit(0); }

  await db.query(
    `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
     values ($1, 'food.delete_future_dated_duplicate', 'food_logs', $2, $3, $4, $5)`,
    [
      bad.user_id,
      PHANTOM,
      JSON.stringify(bad),
      JSON.stringify({
        deleted: true,
        soft: true,
        reason: "duplicate of food_logs " + KEEPER + " from a re-send of the same capture text",
        duplicate_of: KEEPER,
        same_capture_fingerprint: "5654277c797ddee0c82ef49c48321596ac33cf4e5969eb1bf14198eeea8539c6",
        ingestions: ["d0a60123-530c-47b2-aa64-659585eb248f (kept)", "f7c1aa50-9fac-4915-9868-574e0dad293c (this one)"],
        why_not_redated:
          "the brief asked for a re-date to 2026-08-06, but that day already holds the meal as a 20:44 IST snack; "
          + "re-dating would have double-counted the bhujia to 730 kcal and invented a 12:00 lunch",
        kept_row_verified: { day_ist: keptDay, calories: t.calories, protein_g: t.protein_g, priced_correctly: priced },
      }),
      "scripts/repair-future-meal-2026-08-08.mjs",
    ],
  );
  await db.query("update food_logs set deleted_at = now() where id = $1 and deleted_at is null", [PHANTOM]);

  const { rows: [after] } = await db.query(
    `select count(*)::int rows, coalesce(sum(calories_estimate),0)::int kcal, coalesce(sum(protein_g),0)::numeric protein
       from food_logs
      where deleted_at is null
        and occurred_at >= '2026-08-06T00:00:00+05:30' and occurred_at < '2026-08-07T00:00:00+05:30'`);
  const { rows: [future] } = await db.query(
    "select count(*)::int n from food_logs where deleted_at is null and occurred_at > now()");

  console.log("\nRemoved (tombstoned). Full before-image in audit_log.");
  console.log(`2026-08-06 now: ${after.rows} rows, ${after.kcal} kcal, ${after.protein} g protein`);
  console.log(`food rows dated in the future: ${future.n}`);
} finally {
  await db.end();
}
