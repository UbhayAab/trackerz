// Backfill `habit_days.flags.protein_hit` for the days that were closed while
// the protein target had nowhere to live.
//
// THE BUG: jbCloseDay read the daily protein target from `budgets.daily_protein`.
// That table has never held a single row - 0 rows, all users, all time - so
// `protein_hit` was `false` on every day the app has ever closed, and
// `streaks.protein` was permanently 0. Meanwhile the morning brief printed
// "Targets: 162g protein, 2000 kcal" every day, because IT reads the active diet
// plan. The app stated a target at 07:00 and then graded the day against nothing.
//
// THE FIX (lib/jarvis-brief.mjs + supabase/functions/jarvis/index.ts): an absent
// budget row now falls back to the active diet plan's own targets. An explicit
// budget still wins; null still means "no target anywhere", so absence is never
// narrated as failure.
//
// THE WINDOW: the diet plan carrying targets {162 g, 2000 kcal} was written
// 2026-08-06 07:15 IST. Days before that genuinely had no target of record, and
// backdating one would be inventing history - so this only touches 2026-08-06
// onward. 2026-08-08 was already corrected by re-running the closeout.
//
// Idempotent: recomputes from the food rows each time and writes only when the
// stored flag disagrees. Safe to re-run.
//
// Usage: node scripts/repair-protein-flags-2026-08-09.mjs [--apply]
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");
const FROM = "2026-08-06";
// The same 90% rule jbCloseDay uses. Duplicated deliberately: this script must
// keep saying what the engine said on the day it ran, not follow a future edit.
const HIT_RATIO = 0.9;

const c = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || process.env.SUPABASE_DB_URL_POOLER || "").replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await c.connect();

// Every profile is walked, not just the owner: per-day tables are keyed on
// (user_id, day), and a query that forgets that has already invented two
// confident false findings in this repo.
const { rows: days } = await c.query(
  // to_char, NOT the raw date column: node-postgres parses a DATE into a JS Date
  // at LOCAL midnight, so `h.day.toISOString().slice(0,10)` in IST hands back
  // YESTERDAY. The first dry run of this script printed 2026-08-05 for the
  // 2026-08-06 row, and an --apply on that would have written the correction to
  // the wrong day. The day never becomes a Date object now.
  `select h.user_id,
          to_char(h.day, 'YYYY-MM-DD') as day_key,
          h.flags,
          h.streaks,
          coalesce((
            select sum(f.protein_g) from food_logs f
            where f.user_id = h.user_id
              and f.deleted_at is null
              and (f.occurred_at at time zone 'Asia/Kolkata')::date = h.day
          ), 0) as protein,
          (
            select p.payload->'targets'->>'protein_g' from user_plans p
            where p.user_id = h.user_id and p.kind = 'diet' and p.active
              and p.deleted_at is null
            order by p.created_at desc limit 1
          ) as target
     from habit_days h
    where h.day >= $1
    order by h.user_id, h.day`,
  [FROM],
);

const changes = [];
for (const d of days) {
  const target = Number(d.target);
  if (!Number.isFinite(target) || target <= 0) continue;   // no target = no verdict
  const protein = Number(d.protein) || 0;
  const hit = protein >= target * HIT_RATIO;
  if (Boolean(d.flags?.protein_hit) === hit) continue;
  changes.push({ ...d, protein, target, hit });
}

for (const ch of changes) {
  const day = ch.day_key;
  console.log(
    `${ch.user_id.slice(0, 8)} ${day}: ${Math.round(ch.protein)}g vs ${Math.round(ch.target * HIT_RATIO)}g needed ` +
    `-> protein_hit ${ch.flags?.protein_hit ?? null} => ${ch.hit}`,
  );
  if (!APPLY) continue;
  // The streak is rolled from the PREVIOUS stored day, exactly as jbNextStreaks
  // does, so a corrected day cannot fabricate a run that never happened.
  const { rows: prev } = await c.query(
    `select streaks from habit_days where user_id = $1 and day = $2::date - 1`,
    [ch.user_id, day],
  );
  const prevProtein = Number(prev[0]?.streaks?.protein) || 0;
  const nextStreaks = { ...(ch.streaks || {}), protein: ch.hit ? prevProtein + 1 : 0 };
  await c.query(
    `update habit_days
        set flags = flags || jsonb_build_object('protein_hit', $3::boolean),
            streaks = $4::jsonb
      where user_id = $1 and day = $2`,
    [ch.user_id, day, ch.hit, JSON.stringify(nextStreaks)],
  );
}

await c.end();
console.log(
  changes.length
    ? `${changes.length} day(s) ${APPLY ? "corrected" : "would be corrected (re-run with --apply)"}`
    : "nothing to correct - every stored protein_hit already matches the rows",
);
