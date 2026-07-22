import assert from "node:assert/strict";
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

console.log("briefing tests passed");
