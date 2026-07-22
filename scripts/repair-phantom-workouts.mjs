// Repairs the workout rows that were created from captures DENYING a workout.
//
// The fan-out expander used to log a workout whenever a capture merely MENTIONED
// the gym, so "Did not go to gym bro" became a completed session, and the close-
// out counted it, and the next morning's brief congratulated the owner on
// training they had explicitly said they skipped. The code fix stops new ones;
// this repairs the five already in the database.
//
// Nothing is deleted. Rows are re-marked status='skipped' (so history stays
// intact and reversible) and every change is written to audit_log with the
// previous value. Affected habit_days rows are removed so the next close-out
// recomputes them from corrected data.
//
// Usage: node scripts/repair-phantom-workouts.mjs           (dry run)
//        node scripts/repair-phantom-workouts.mjs --apply
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { declaresNoWorkout } from "../lib/negation.mjs";
import { looksLikeGym } from "../lib/capture-intent.mjs";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here — set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const APPLY = process.argv.includes("--apply");

// Same predicate the live pipeline now uses, so the repair and the fix agree.
const mentionsGym = (t) => looksLikeGym(t) || /\bwork\s?out\b/i.test(t);

const client = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  const { rows } = await client.query(
    `select id, user_id, description, status, occurred_at from workout_logs where status = 'done' order by occurred_at`
  );

  const phantom = rows.filter((r) => declaresNoWorkout(r.description || "", mentionsGym));
  // A plan EDIT is not a workout either ("Change gym today to chest workout").
  const planEdits = rows.filter(
    (r) => !phantom.includes(r) && /^(change|update|switch|make|set)\b/i.test(String(r.description || "").trim())
  );

  const targets = [...phantom, ...planEdits];

  console.log(`${rows.length} rows currently marked done; ${targets.length} are not real workouts:\n`);
  for (const r of targets) {
    const why = phantom.includes(r) ? "denies the workout" : "is a plan edit, not a session";
    console.log(`  ${r.occurred_at.toISOString().slice(0, 10)}  ${why.padEnd(32)}  "${String(r.description).slice(0, 78)}"`);
  }
  const keeping = rows.filter((r) => !targets.includes(r));
  console.log(`\n${keeping.length} genuine workouts kept:`);
  for (const r of keeping) {
    console.log(`  ${r.occurred_at.toISOString().slice(0, 10)}  "${String(r.description).slice(0, 78)}"`);
  }

  if (!targets.length) { console.log("\nnothing to repair."); process.exit(0); }
  if (!APPLY) { console.log("\ndry run — pass --apply to write"); process.exit(0); }

  await client.query("begin");
  for (const r of targets) {
    await client.query(`update workout_logs set status = 'skipped' where id = $1`, [r.id]);
    await client.query(
      `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
       values ($1, 'repair.phantom_workout', 'workout_logs', $2, $3, $4, 'scripts/repair-phantom-workouts.mjs')`,
      [r.user_id, r.id, JSON.stringify({ status: r.status }), JSON.stringify({ status: "skipped", description: r.description })],
    );
  }

  // Drop the habit_days rows that were computed from the bad data. The next
  // close-out (or a forced jarvis run) rebuilds them; leaving them would keep
  // the wrong gym flags and streaks in every future brief.
  const days = [...new Set(targets.map((r) => r.occurred_at.toISOString().slice(0, 10)))];
  const del = await client.query(
    `delete from habit_days where day = any($1::date[]) returning day`, [days]
  );
  await client.query("commit");

  console.log(`\nre-marked ${targets.length} rows as skipped (audit_log has the previous values)`);
  console.log(`cleared ${del.rowCount} habit_days rows for ${days.join(", ")} — they recompute on the next close-out`);
} catch (err) {
  await client.query("rollback").catch(() => {});
  console.error("rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
