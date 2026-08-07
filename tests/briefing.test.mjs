import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBriefing } from "../src/analytics/briefing.js";

// ---- morning: forward-looking plan + targets ----
{
  const b = buildBriefing("morning", {
    forDate: "2026-06-30", weekdayName: "Monday", dietLabel: "Soybean day",
    workoutName: "Workout A", workoutKind: "gym",
    proteinTarget: 162, caloriesTarget: 2000, dailySpendCap: 1500,
  });
  assert.equal(b.kind, "morning");
  assert.equal(b.forDate, "2026-06-30");
  assert.ok(b.body.startsWith("Good morning - Monday, Soybean day."), b.body);
  assert.ok(b.body.includes("Planned: Workout A."));
  assert.ok(b.body.includes("162g protein, 2000 kcal"));
  assert.ok(b.body.includes("~Rs 1500"));
  assert.equal(b.payload.headline, "Good morning - Monday, Soybean day.");
  assert.ok(b.payload.nudges.length >= 2);
}

// morning on a cardio day flags the forgiven-day label
{
  const b = buildBriefing("morning", { weekdayName: "Tuesday", workoutName: "Cardio - forgiven day", workoutKind: "cardio", proteinTarget: 162 });
  assert.ok(b.body.includes("forgiven cardio day"));
}

// morning degrades gracefully with a sparse snapshot
{
  const b = buildBriefing("morning", {});
  assert.ok(b.body.startsWith("Good morning - today."), b.body);
}

// ---- evening: behind on everything -> a full nudge list ----
{
  const b = buildBriefing("evening", {
    proteinToday: 100, proteinTarget: 162,
    caloriesToday: 2200, caloriesTarget: 2000,
    workoutName: "Workout A", workoutKind: "gym", workoutLoggedToday: false,
    todaySpend: 1800, dailySpendCap: 1500,
    planItemsLeft: 3,
  });
  assert.equal(b.kind, "evening");
  const n = b.payload.nudges;
  assert.ok(n.includes("62g protein to go"), JSON.stringify(n));
  assert.ok(n.includes("200 kcal over target"));
  assert.ok(n.some((x) => x.startsWith("gym not logged")));
  assert.ok(n.includes("over today's spend by Rs 300"));
  assert.ok(n.includes("3 plan items left"));
  assert.equal(n.length, 5);
  assert.ok(b.body.includes("a few things left"));
}

// ---- evening: on track -> no nudges ----
{
  const b = buildBriefing("evening", {
    proteinToday: 170, proteinTarget: 162,
    caloriesToday: 1800, caloriesTarget: 2000,
    workoutKind: "gym", workoutLoggedToday: true,
    todaySpend: 200, dailySpendCap: 1500,
    planItemsLeft: 0,
  });
  assert.equal(b.payload.nudges.length, 0, JSON.stringify(b.payload.nudges));
  assert.ok(b.body.includes("on track"));
}

// small protein gap (<=10) is NOT nagged; being UNDER calories is fine
{
  const b = buildBriefing("evening", { proteinToday: 155, proteinTarget: 162, caloriesToday: 1500, caloriesTarget: 2000, workoutKind: "rest", workoutLoggedToday: false });
  assert.equal(b.payload.nudges.length, 0, "8g gap + under calories + rest day = on track");
}

// singular plan item phrasing
{
  const b = buildBriefing("evening", { planItemsLeft: 1, proteinTarget: 0, caloriesTarget: 0 });
  assert.ok(b.payload.nudges.includes("1 plan item left"));
}

// rest day never nags about the gym
{
  const b = buildBriefing("evening", { workoutKind: "rest", workoutLoggedToday: false, proteinTarget: 0, caloriesTarget: 0 });
  assert.ok(!b.payload.nudges.some((x) => x.includes("gym")));
}

// stats are always carried for the UI
{
  const b = buildBriefing("evening", { proteinToday: 100, proteinTarget: 162, todaySpend: 300, workoutLoggedToday: true });
  assert.deepEqual(b.payload.stats, { proteinToday: 100, proteinTarget: 162, caloriesToday: 0, caloriesTarget: 0, todaySpend: 300, workoutLoggedToday: true });
}

// ---------------------------------------------------------------------------
// ONE habit_days ROW PER USER PER DAY.
//
// This block exists because of a WRONG finding, and the wrongness is the point.
// A 2026-08-08 audit reported that habit_days held "49 rows for 32 days, 17 of
// them duplicated, with 2026-08-07 present twice as workout:true/streak 19 and
// workout:false/streak 1" - and that two closeout briefings 271 ms apart
// contradicted each other. It concluded the pg_cron slot and the GitHub Actions
// heartbeat were both firing closeout non-idempotently.
//
// None of that was true. The query behind it was `count(*) - count(distinct
// day)` with no `user_id` in the grouping. This database has THREE profiles;
// the 49 rows are 32 + 16 + 1, every one of them a distinct (user_id, day), and
// the two "contradicting" briefings belong to two different people. Re-queried
// as `count(distinct (user_id, day))`: 49 rows, 49 distinct user-days, 0
// duplicates. The owner's own streak series runs 1..19 across 2026-07-20 to
// 2026-08-07 with no reset.
//
// So there was nothing to deduplicate and no streak to recompute. What was
// missing was a guard that could have answered the question in one second, and
// that is what these assertions are. They lock BOTH halves of the invariant,
// because either one alone permits the duplicate:
//   - the table must declare unique(user_id, day), and
//   - the closeout upsert must name that exact pair as its conflict target.
// An upsert keyed on `day` alone against a unique(user_id, day) index would
// throw; a unique(day) index would silently let one user overwrite another.
{
  const schema = readFileSync("supabase/schema.sql", "utf8");
  const habitTable = schema.slice(schema.indexOf("create table if not exists public.habit_days"));
  const habitBody = habitTable.slice(0, habitTable.indexOf(");"));
  assert.match(
    habitBody,
    /unique\s*\(\s*user_id\s*,\s*day\s*\)/i,
    "habit_days must declare unique(user_id, day) - without it two users, or two closeout runs, can hold the same day",
  );

  const jarvis = readFileSync("supabase/functions/jarvis/index.ts", "utf8");
  const upsertAt = jarvis.indexOf('from("habit_days").upsert');
  assert.ok(upsertAt > -1, "jarvis closeout must UPSERT habit_days, never insert");
  assert.match(
    jarvis.slice(upsertAt, upsertAt + 400),
    /onConflict:\s*"user_id,day"/,
    'the habit_days upsert must use onConflict "user_id,day" so a re-fired closeout updates the day instead of adding a second row',
  );

  // The heartbeat re-fires the same slots as a fallback scheduler, so closeout
  // has to be safe to run twice. It reads the existing row first and returns
  // early unless --force is passed.
  assert.match(
    jarvis.slice(Math.max(0, upsertAt - 1600), upsertAt),
    /existing\s*&&\s*!force/,
    "runCloseout must short-circuit on an already-closed day unless forced, or the heartbeat rewrites finished days",
  );

  // BRIEFINGS ARE PER USER TOO, and the same missing `user_id` produced the same
  // false alarm a second time: two closeout rows 271 ms apart on 2026-08-07 with
  // opposite conclusions ("workout done. Streaks: gym 2d." and "no workout")
  // were read as one engine contradicting itself. They belong to two different
  // profiles - 548339a8 and 2f953b03. Live: briefings holds 169 rows and 169
  // distinct (user_id, kind, for_date) triples, 0 duplicates, behind a UNIQUE
  // constraint on exactly that triple. The 271 ms is the closeout loop walking
  // three profiles in one invocation, which is what it is supposed to do.
  const schemaBriefings = schema.slice(schema.indexOf("create table if not exists public.briefings"));
  assert.match(
    schemaBriefings.slice(0, schemaBriefings.indexOf(");")),
    /unique\s*\(\s*user_id\s*,\s*kind\s*,\s*for_date\s*\)/i,
    "briefings must declare unique(user_id, kind, for_date) - it is what makes a re-fired slot an update instead of a second row",
  );
}

// ---- a default is not a goal --------------------------------------------
//
// The live `budgets` table has been EMPTY for the life of this app, so the
// 162g/2000kcal in every brief came from lib/diet-scaffold.mjs, not from him.
// Stating it back as "Targets:" told him for 43 consecutive days that he had
// missed a goal he never set. Same disease as rendering absent data as a
// measured zero, one layer up.
{
  const base = {
    forDate: "2026-08-08", weekdayName: "Friday",
    proteinTarget: 162, caloriesTarget: 2000,
  };

  const mine = buildBriefing("morning", {
    ...base, targetSources: { protein_g: "user", calories: "user" },
  });
  assert.match(mine.body, /Targets: 162g protein, 2000 kcal\./);
  assert.doesNotMatch(mine.body, /default/i, "a target he actually set must not be hedged");

  const theirs = buildBriefing("morning", {
    ...base, targetSources: { protein_g: "default", calories: "default" },
  });
  assert.match(theirs.body, /Targets \(app defaults, not set by you\): 162g protein, 2000 kcal\./);

  const mixed = buildBriefing("morning", {
    ...base, targetSources: { protein_g: "user", calories: "default" },
  });
  assert.match(mixed.body, /Targets \(partly app defaults\)/);

  // ABSENT IS NOT "user". An old snapshot with no targetSources cannot prove he
  // set anything, so it must not claim he did - but it must not accuse the app
  // either. Neutral wording, no authorship claim in either direction.
  const unknown = buildBriefing("morning", base);
  assert.match(unknown.body, /Targets: 162g protein/);
  assert.doesNotMatch(unknown.body, /not set by you/);

  // Only the targets actually being stated count. Calories absent + protein
  // defaulted is still an all-default line.
  const proteinOnly = buildBriefing("morning", {
    forDate: "2026-08-08", proteinTarget: 162,
    targetSources: { protein_g: "default", calories: "user" },
  });
  assert.match(proteinOnly.body, /Targets \(app defaults, not set by you\): 162g protein\./);
}

// ---- the evening shortfall names whose target it missed -------------------
{
  const evening = buildBriefing("evening", {
    forDate: "2026-08-08", proteinToday: 11, proteinTarget: 162,
    targetSources: { protein_g: "default", calories: "default" },
  });
  assert.match(evening.body, /151g protein to go \(app default target\)/);

  const owned = buildBriefing("evening", {
    forDate: "2026-08-08", proteinToday: 11, proteinTarget: 162,
    targetSources: { protein_g: "user", calories: "user" },
  });
  assert.match(owned.body, /151g protein to go/);
  assert.doesNotMatch(owned.body, /app default/);

  // Over on calories against a default target, same rule.
  const over = buildBriefing("evening", {
    forDate: "2026-08-08", caloriesToday: 2600, caloriesTarget: 2000,
    targetSources: { protein_g: "default", calories: "default" },
  });
  assert.match(over.body, /600 kcal over target \(app default\)/);
}

console.log("briefing tests passed");
