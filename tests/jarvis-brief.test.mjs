// Jarvis brief brain — day-close math, streaks, facts, deterministic voice.
import assert from "node:assert/strict";
import {
  jbDateKeyInTz, jbDayWindow, jbAddDays, jbWeekdayFromKey, jbDaysLeftInMonth,
  jbInQuietHours, jbPlannedWorkout, jbDailySpendCap, jbCloseDay, jbNextStreaks,
  jbSafeToSpend, jbBriefFacts, jbMorningFallback, jbEveningBody, jbCloseoutBody,
  jbWeeklySummary, JB_VOICE_SYSTEM, jbVoiceUserPrompt,
} from "../lib/jarvis-brief.mjs";

const IST = "Asia/Kolkata";

// --- timezone math -----------------------------------------------------------
// 2026-07-05T18:35:00Z = 2026-07-06 00:05 IST — the close-out fires just past
// IST midnight and must resolve to the NEW IST day.
assert.equal(jbDateKeyInTz(new Date("2026-07-05T18:35:00Z"), IST), "2026-07-06");
assert.equal(jbDateKeyInTz(new Date("2026-07-05T18:29:00Z"), IST), "2026-07-05");

const win = jbDayWindow("2026-07-05", IST);
assert.equal(win.startISO, "2026-07-04T18:30:00.000Z"); // 00:00 IST
assert.equal(win.endISO, "2026-07-05T18:30:00.000Z");   // next 00:00 IST

assert.equal(jbAddDays("2026-07-01", -1), "2026-06-30");
assert.equal(jbAddDays("2026-12-31", 1), "2027-01-01");
assert.equal(jbWeekdayFromKey("2026-07-06"), 1); // Monday
assert.equal(jbWeekdayFromKey("2026-07-05"), 7); // Sunday
assert.equal(jbDaysLeftInMonth("2026-07-05"), 27);
assert.equal(jbDaysLeftInMonth("2026-07-31"), 1);

// --- quiet hours (22:30 → 06:45 wraps midnight) ------------------------------
const quiet = { start: "22:30", end: "06:45" };
assert.equal(jbInQuietHours(new Date("2026-07-05T18:30:00Z"), IST, quiet), true);  // 00:00 IST
assert.equal(jbInQuietHours(new Date("2026-07-05T17:30:00Z"), IST, quiet), true);  // 23:00 IST
assert.equal(jbInQuietHours(new Date("2026-07-05T15:00:00Z"), IST, quiet), false); // 20:30 IST
assert.equal(jbInQuietHours(new Date("2026-07-06T01:30:00Z"), IST, quiet), false); // 07:00 IST
assert.equal(jbInQuietHours(new Date("2026-07-06T01:00:00Z"), IST, quiet), true);  // 06:30 IST
assert.equal(jbInQuietHours(new Date(), IST, null), false);

// --- planned workout ---------------------------------------------------------
assert.deepEqual(jbPlannedWorkout(1, null), { name: "Workout A", kind: "gym" });
assert.equal(jbPlannedWorkout(2, null).kind, "cardio");
assert.deepEqual(
  jbPlannedWorkout(1, { days: { Mon: { name: "Push day", kind: "gym" } } }),
  { name: "Push day", kind: "gym" },
);
assert.deepEqual(jbPlannedWorkout(3, { name: "Full body", kind: "gym" }), { name: "Full body", kind: "gym" });
// A days-map payload without an entry for the weekday falls back to the scaffold.
assert.deepEqual(jbPlannedWorkout(5, { days: { Mon: { name: "Push" } } }), { name: "Workout B", kind: "gym" });

// --- close-out math ----------------------------------------------------------
const budgets = [
  { kind: "monthly_spend", amount: 30000 },
  { kind: "daily_protein", amount: 150 },
  { kind: "daily_calories", amount: 1800 },
  { kind: "weekly_workouts", amount: 5 },
];
assert.equal(jbDailySpendCap(budgets), 1000);
assert.equal(jbDailySpendCap([{ kind: "weekly_spend", amount: 7000 }]), 1000);
assert.equal(jbDailySpendCap([]), null);

const day = jbCloseDay({
  ledger: [
    { amount: 240, direction: "expense", is_discretionary: true },
    { amount: 500, direction: "expense", is_discretionary: false },
    { amount: 90000, direction: "income" },
    { amount: 1000, direction: "transfer" },
  ],
  foods: [
    { protein_g: 42, calories_estimate: 500 },
    { protein_g: 100, calories_estimate: 900 },
  ],
  workouts: [{ duration_min: 50 }],
  wellness: [{ mood_score: 8 }, { mood_score: 6 }],
  bodyMetrics: [
    { metric_type: "sleep_hours", value: 7.25 },
    { metric_type: "weight", value: 82.4 },
    { metric_type: "steps", value: 6000 },
  ],
  budgets,
  plannedKind: "gym",
});
assert.equal(day.spend, 740);
assert.equal(day.discretionarySpend, 240);
assert.equal(day.income, 90000);
assert.equal(day.protein, 142);
assert.equal(day.calories, 1400);
assert.equal(day.meals, 2);
assert.equal(day.workoutDone, true);
assert.equal(day.sleepH, 7.3);
assert.equal(day.weightKg, 82.4);
assert.equal(day.moodAvg, 7);
assert.equal(day.flags.protein_hit, true);        // 142 >= 0.9 * 150
assert.equal(day.flags.under_budget, true);       // 740 <= 1000
assert.equal(day.flags.workout_ok, true);
assert.equal(day.flags.logged, true);

// 10k steps count as the workout on any day; an empty day earns nothing.
const stepsDay = jbCloseDay({ bodyMetrics: [{ metric_type: "steps", value: 11000 }], budgets: [], plannedKind: "cardio" });
assert.equal(stepsDay.workoutDone, true);
const emptyDay = jbCloseDay({ budgets, plannedKind: "gym" });
assert.equal(emptyDay.flags.logged, false);
assert.equal(emptyDay.flags.workout_ok, false);
assert.equal(emptyDay.flags.protein_hit, false);
// A rest day is forgiven even with nothing logged.
assert.equal(jbCloseDay({ budgets: [], plannedKind: "rest" }).flags.workout_ok, true);

// --- streaks -----------------------------------------------------------------
const s1 = jbNextStreaks(null, day.flags);
assert.deepEqual(s1, { workout: 1, protein: 1, budget: 1, logging: 1 });
const s2 = jbNextStreaks({ workout: 4, protein: 9, budget: 2, logging: 30 }, day.flags);
assert.deepEqual(s2, { workout: 5, protein: 10, budget: 3, logging: 31 });
// An empty day resets activity streaks but keeps budget alive (Rs 0 is under cap).
const s3 = jbNextStreaks(s2, emptyDay.flags);
assert.deepEqual(s3, { workout: 0, protein: 0, budget: 4, logging: 0 });

// --- safe to spend + facts ---------------------------------------------------
assert.deepEqual(jbSafeToSpend({ monthlyCap: 0 }), { hasBudget: false });
const safe = jbSafeToSpend({ monthlyCap: 30000, monthSpend: 12000, daysLeft: 10, subsDueTotal: 500 });
assert.deepEqual(safe, { hasBudget: true, monthlyCap: 30000, remaining: 17500, daysLeft: 10, perDay: 1750 });

const facts = jbBriefFacts({
  dateKey: "2026-07-06", // Monday
  budgets,
  gymPayload: null,
  yesterday: { ...day, flags: day.flags },
  streaks: s2,
  monthSpend: 3200,
  subsDue: [{ merchant: "Netflix", amount: 199, in_days: 3 }],
  weeklyWorkouts: 3,
});
assert.equal(facts.weekday, "Monday");
assert.equal(facts.diet_label, "Soybean day");
assert.equal(facts.workout.name, "Workout A");
assert.equal(facts.targets.protein_g, 150);
assert.equal(facts.targets.spend_cap, 1000);
assert.equal(facts.yesterday.workout_done, true);
assert.equal(facts.money.hasBudget, true);
assert.equal(facts.money.remaining, 30000 - 3200 - 199);
assert.equal(facts.money.daysLeft, 26);
assert.equal(facts.subs_due.length, 1);
assert.deepEqual(facts.weekly_workouts, { done: 3, target: 5 });
assert.equal(facts.yesterday.protein_hit, true);
assert.equal(facts.yesterday.under_budget, true);

// No cap/target set → nulls in the facts (never narrated as "missed"/"over").
const noTargetDay = jbCloseDay({ ledger: [{ amount: 300, direction: "expense" }], budgets: [], plannedKind: "gym" });
const noTargetFacts = jbBriefFacts({
  dateKey: "2026-07-06", budgets: [], gymPayload: null,
  yesterday: { ...noTargetDay, flags: noTargetDay.flags },
  streaks: {}, monthSpend: 300, subsDue: [], weeklyWorkouts: 0,
});
assert.equal(noTargetFacts.yesterday.protein_hit, null);
assert.equal(noTargetFacts.yesterday.under_budget, null);
assert.equal(noTargetFacts.money.hasBudget, false);

// --- deterministic voices ----------------------------------------------------
const morning = jbMorningFallback(facts);
assert.ok(morning.includes("Good morning — Monday, Soybean day."));
assert.ok(morning.includes("Workout A"));
assert.ok(morning.includes("150g protein"));
assert.ok(morning.includes("Netflix Rs 199 expected in 3d."));
assert.ok(morning.includes("gym 5d"));
assert.ok(morning.includes("Safe to spend:"));

const evening = jbEveningBody({
  proteinTarget: 150, proteinToday: 40, caloriesTarget: 1800, caloriesToday: 2000,
  plannedKind: "gym", plannedName: "Workout A", workoutLogged: false,
  spendCap: 1000, todaySpend: 1400,
});
assert.equal(evening.nudges.length, 4);
assert.ok(evening.body.includes("110g protein to go"));
assert.ok(evening.body.includes("200 kcal over target"));
assert.ok(evening.body.includes("gym not logged yet (Workout A)"));
assert.ok(evening.body.includes("over today's spend by Rs 400"));
const calmEvening = jbEveningBody({ proteinTarget: 150, proteinToday: 148, plannedKind: "rest", workoutLogged: false });
assert.equal(calmEvening.nudges.length, 0);
assert.ok(calmEvening.body.includes("on track"));

const closeout = jbCloseoutBody(day, s2);
assert.ok(closeout.includes("Day closed:"));
assert.ok(closeout.includes("Rs 740 spent (under cap)"));
assert.ok(closeout.includes("142g protein (hit)"));
assert.ok(closeout.includes("workout done"));
assert.ok(closeout.includes("slept 7.3h"));
assert.ok(closeout.includes("gym 5d"));

const weekly = jbWeeklySummary([
  { summary: { spend: 500, protein: 140, calories: 1700, sleepH: 7 }, flags: { workout_ok: true, protein_hit: true, under_budget: true, logged: true }, streaks: { workout: 1 } },
  { summary: { spend: 1500, protein: 90, calories: 2100, sleepH: 0 }, flags: { workout_ok: false, protein_hit: false, under_budget: false, logged: true }, streaks: { workout: 0 } },
]);
assert.equal(weekly.days, 2);
assert.equal(weekly.totals.spend, 2000);
assert.equal(weekly.totals.workouts, 1);
assert.equal(weekly.averages.protein, 115);
assert.equal(weekly.averages.sleep_h, 7);
assert.deepEqual(weekly.hits, { workout_days: 1, protein_days: 1, budget_days: 1, logged_days: 2 });
assert.deepEqual(weekly.end_streaks, { workout: 0 });

// --- voice contract ----------------------------------------------------------
assert.ok(JB_VOICE_SYSTEM.includes("copied verbatim from the facts JSON"));
assert.ok(JB_VOICE_SYSTEM.includes("plain text only"));
const prompt = jbVoiceUserPrompt(facts);
assert.ok(prompt.startsWith("FACTS JSON:\n{"));
assert.ok(prompt.includes('"for_date":"2026-07-06"'));

console.log("jarvis-brief tests passed");
