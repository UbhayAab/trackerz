// One-off repair, approved by the owner on 2026-07-31.
//
// Every row in `notes` was a misfile (see docs/AUDIT-2026-07-31.md). The routing
// defect is fixed in lib/fan-out-expander.mjs (dropRestatingNotes), but the
// historical rows are still there, and the AI's memory context reads them - so
// two "no gym today" notes from 23 July keep telling the model he skipped a
// morning he actually trained.
//
// Three actions, all audit-logged, none of which loses an event:
//   DELETE  5 notes that restate a domain row from the SAME capture.
//   CONVERT 1 note whose event was never recorded, into the workout row.
//   DELETE  2 notes contradicted by what actually happened that day.
//
// Plus: 2 real meals that were captured, marked 'processed', and written
// nowhere. Backfilled onto their original ingestion ids with macros from
// lib/food-nutrition.mjs - not estimated by hand.
//
// Usage: node scripts/repair-notes-2026-07-31.mjs [--apply]
//        (defaults to a dry run that writes nothing)
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";
import { estimateNutrition } from "../lib/food-nutrition.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

// Identified by body + timestamp rather than uuid so this file reads as the
// audit it is. Every one was verified against the domain row from the same
// ingestion before being listed here.
const RESTATING = [
  ["2026-07-05 15:31", "Did not go to gym today", "workout_logs status=skipped from the same capture"],
  ["2026-07-05 21:50", "Going to Nagpur July 6-7", "workout_logs status=skipped from the same capture"],
  ["2026-07-09 14:38", "No gym today", "workout_logs status=skipped from the same capture"],
  ["2026-07-23 05:26", "In gym, doing back", "workout_logs status=done from the same capture"],
  ["2026-07-28 06:29", "Coca Cola Zero Sugar", "food_logs from the same capture"],
];
const CONTRADICTED = [
  ["2026-07-23 02:35", "No gym today", "he trained at 05:00 that morning; workout_logs status=done exists"],
  ["2026-07-23 02:35", "Did not go to gym bro", "duplicate of the above, same minute, same contradiction"],
];
const CONVERT = [
  ["2026-07-01 10:22", "Did not go to gym today", "no workout row was ever written for this skip"],
];
// NOT every zero-row capture is a lost meal. "Masala dosa" at 2026-07-26
// 12:48:30 produced nothing, but two more captures followed within 78 seconds -
// 12:49:06 (correctly flagged duplicate) and 12:49:48 "Masala dosa. And
// sambhar", which DID log 400 kcal. It was a retry of a meal that eventually
// landed, not a second dosa. It was backfilled in the first run of this script
// and reverted immediately (audit_log action capture.backfill_reverted).
//
// The rule this taught: before backfilling a silent-loss capture, check for a
// neighbouring capture of the SAME meal that succeeded.
const LOST_MEALS = [
  ["2026-07-25 15:48", "500g curd, added in blender. Blueberries. Sugar"],
];

const client = await connectDb();

async function findNote(stamp, bodyStart) {
  const { rows } = await client.query(
    `select id, user_id, ingestion_id, body, created_at
       from notes
      where to_char(created_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') = $1
        and body like $2
      limit 1`,
    [stamp, bodyStart + "%"],
  );
  return rows[0] || null;
}

async function audit(userId, action, table, targetId, before, after) {
  if (!APPLY) return;
  await client.query(
    `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
     values ($1,$2,$3,$4,$5,$6,'scripts/repair-notes-2026-07-31.mjs')`,
    [userId, action, table, targetId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}

let deleted = 0, converted = 0, backfilled = 0, missing = 0;
console.log(APPLY ? "APPLYING\n" : "DRY RUN - nothing will be written (pass --apply)\n");

for (const [group, list, reasonLabel] of [
  ["restates a domain row", RESTATING, "note.delete_restating"],
  ["contradicted by the day", CONTRADICTED, "note.delete_contradicted"],
]) {
  for (const [stamp, bodyStart, why] of list) {
    const note = await findNote(stamp, bodyStart);
    if (!note) { console.log(`  MISS  ${stamp} "${bodyStart}" - not found, skipping`); missing += 1; continue; }
    console.log(`  DELETE ${stamp} "${note.body.split("\n")[0].slice(0, 46)}"`);
    console.log(`         ${group}: ${why}`);
    if (APPLY) {
      await audit(note.user_id, reasonLabel, "notes", note.id, note, null);
      await client.query("delete from notes where id = $1", [note.id]);
    }
    deleted += 1;
  }
}

for (const [stamp, bodyStart, why] of CONVERT) {
  const note = await findNote(stamp, bodyStart);
  if (!note) { console.log(`  MISS  ${stamp} "${bodyStart}" - not found, skipping`); missing += 1; continue; }
  console.log(`  CONVERT ${stamp} "${note.body.slice(0, 46)}" -> workout_logs status=skipped`);
  console.log(`          ${why}`);
  if (APPLY) {
    const { rows } = await client.query(
      `insert into workout_logs (user_id, ingestion_id, description, status, occurred_at)
       values ($1,$2,$3,'skipped',$4) returning id`,
      [note.user_id, note.ingestion_id, note.body.slice(0, 200), note.created_at],
    );
    await audit(note.user_id, "note.convert_to_workout", "workout_logs", rows[0].id, note, { status: "skipped" });
    await client.query("delete from notes where id = $1", [note.id]);
  }
  converted += 1;
}

for (const [stamp, text] of LOST_MEALS) {
  const { rows } = await client.query(
    `select id, user_id, raw_text, created_at from raw_ingestions
      where to_char(created_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') = $1 limit 1`,
    [stamp],
  );
  const ing = rows[0];
  if (!ing) { console.log(`  MISS  ${stamp} ingestion not found`); missing += 1; continue; }
  const already = await client.query("select 1 from food_logs where ingestion_id = $1", [ing.id]);
  if (already.rowCount) { console.log(`  SKIP  ${stamp} already has a food row`); continue; }

  const est = estimateNutrition(ing.raw_text || text);
  const t = est.totals;
  console.log(`  BACKFILL ${stamp} "${(ing.raw_text || text).slice(0, 46)}"`);
  console.log(`           ${t.calories} kcal · P${t.protein_g} C${t.carbs_g} F${t.fat_g}` +
    `  (recognized=${est.recognized}${est.unknown.length ? `, unpriced: ${est.unknown.join(", ")}` : ""})`);
  if (APPLY) {
    const ins = await client.query(
      `insert into food_logs (user_id, ingestion_id, description, calories_estimate, protein_g, carbs_g, fat_g, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [ing.user_id, ing.id, ing.raw_text || text, t.calories, t.protein_g, t.carbs_g, t.fat_g, ing.created_at],
    );
    await audit(ing.user_id, "capture.backfill_lost_meal", "food_logs", ins.rows[0].id, null,
      { ingestion_id: ing.id, totals: t, recognized: est.recognized, unknown: est.unknown });
  }
  backfilled += 1;
}

const { rows: left } = await client.query("select count(*)::int n from notes");
await client.end();

console.log(`\n${APPLY ? "applied" : "would apply"}: ${deleted} deleted, ${converted} converted, ${backfilled} meals backfilled` +
  (missing ? `, ${missing} not found` : ""));
console.log(`notes remaining: ${left[0].n}${APPLY ? "" : " (unchanged - dry run)"}`);
