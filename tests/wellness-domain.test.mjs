import assert from "node:assert/strict";
import { computeHabitScore } from "../src/domain/wellness/habit-score.js";
import { computeSleepDebt } from "../src/domain/wellness/sleep-debt.js";
import { computeStepSummary } from "../src/domain/wellness/step-summary.js";
import { findMoodTriggers } from "../src/domain/wellness/mood-triggers.js";
import { computeRecovery } from "../src/domain/wellness/recovery-score.js";
import { composeWeeklyReview } from "../src/domain/wellness/weekly-review.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(n, hour = 9) {
  const d = new Date(Date.now() - n * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

// -----------------------------------------------------------------------------
// computeHabitScore
// -----------------------------------------------------------------------------

const wellnessLogs = [];
const bodyMetrics = [];
const foodLogs = [];
const ledger = [];

// 7 days of healthy data
for (let i = 0; i < 7; i++) {
  bodyMetrics.push({ metric_type: "sleep_hours", value: 7.5, occurred_at: isoDaysAgo(i, 7) });
  bodyMetrics.push({ metric_type: "steps", value: 8500, occurred_at: isoDaysAgo(i, 20) });
  foodLogs.push({
    description: "chicken bowl",
    meal_name: "lunch",
    protein_g: 60,
    calories_estimate: 700,
    occurred_at: isoDaysAgo(i, 13),
  });
  foodLogs.push({
    description: "paneer wrap",
    meal_name: "dinner",
    protein_g: 55,
    calories_estimate: 650,
    occurred_at: isoDaysAgo(i, 20),
  });
  wellnessLogs.push({
    note: i % 2 === 0 ? "yoga and run" : "felt great",
    mood_score: 7,
    occurred_at: isoDaysAgo(i, 21),
  });
  ledger.push({
    direction: "expense",
    amount: 600,
    merchant: "Cafe Coffee",
    occurred_at: isoDaysAgo(i, 11),
  });
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const healthy = computeHabitScore({
  wellnessLogs,
  bodyMetrics,
  foodLogs,
  ledger,
  todayISO: today.toISOString(),
});

assert.equal(typeof healthy.score, "number", "habit score is numeric");
assert.ok(healthy.score >= 80, `healthy fixture should score >= 80, got ${healthy.score}`);
assert.ok(Array.isArray(healthy.components), "components is array");
assert.equal(healthy.components.length, 6, "six components");
const sleepC = healthy.components.find((c) => c.name === "sleep");
assert.ok(sleepC.hit, "sleep should hit at 7.5h avg");
assert.ok(healthy.components.find((c) => c.name === "steps").hit, "steps hit at 8500 avg");
assert.ok(healthy.components.find((c) => c.name === "protein").hit, "protein hit 5+ days");
assert.ok(healthy.components.find((c) => c.name === "mood").hit, "mood stable");
assert.ok(healthy.components.find((c) => c.name === "workout").hit, "workouts logged");

// Unhealthy fixture
const badBody = [];
const badFood = [];
const badWellness = [];
const badLedger = [];
for (let i = 0; i < 7; i++) {
  badBody.push({ metric_type: "sleep_hours", value: 5, occurred_at: isoDaysAgo(i, 7) });
  badBody.push({ metric_type: "steps", value: 2000, occurred_at: isoDaysAgo(i, 20) });
  badFood.push({ description: "burger", protein_g: 10, calories_estimate: 800, occurred_at: isoDaysAgo(i, 13) });
  badWellness.push({ note: "stressed", mood_score: 2, occurred_at: isoDaysAgo(i, 21) });
  badLedger.push({ direction: "expense", amount: 5000, occurred_at: isoDaysAgo(i, 11) });
}
const bad = computeHabitScore({
  wellnessLogs: badWellness,
  bodyMetrics: badBody,
  foodLogs: badFood,
  ledger: badLedger,
  todayISO: today.toISOString(),
});
assert.ok(bad.score <= 20, `unhealthy fixture should score low, got ${bad.score}`);
assert.equal(bad.components.find((c) => c.name === "sleep").hit, false);
assert.equal(bad.components.find((c) => c.name === "mood").hit, false);
assert.equal(bad.components.find((c) => c.name === "budget").hit, false, "5000/day blows weekly cap");

// Empty fixture
const empty = computeHabitScore({ todayISO: today.toISOString() });
assert.equal(typeof empty.score, "number");
assert.equal(empty.components.length, 6);

// -----------------------------------------------------------------------------
// computeSleepDebt
// -----------------------------------------------------------------------------

const sleepMetrics = [
  { metric_type: "sleep_hours", value: 6, occurred_at: isoDaysAgo(1) },
  { metric_type: "sleep_hours", value: 5, occurred_at: isoDaysAgo(2) },
  { metric_type: "sleep_hours", value: 7, occurred_at: isoDaysAgo(3) },
  { metric_type: "steps", value: 4000, occurred_at: isoDaysAgo(1) }, // ignored
];
const debt = computeSleepDebt(sleepMetrics, 8);
// 8-6=2, 8-5=3, 8-7=1 → total debt 6h.
assert.equal(debt.debtHours, 6, "expected 6h debt from {6,5,7}");
assert.equal(debt.dailyAvg, 6, "(6+5+7)/3=6");
assert.ok(debt.worstNight, "has worst night");
assert.equal(debt.worstNight.hours, 5);

const emptyDebt = computeSleepDebt([]);
assert.equal(emptyDebt.debtHours, 0);
assert.equal(emptyDebt.worstNight, null);

// -----------------------------------------------------------------------------
// computeStepSummary
// -----------------------------------------------------------------------------

const stepMetrics = [
  { metric_type: "steps", value: 8000, occurred_at: isoDaysAgo(1) },
  { metric_type: "steps", value: 12000, occurred_at: isoDaysAgo(2) },
  { metric_type: "steps", value: 3000, occurred_at: isoDaysAgo(3) },
  { metric_type: "sleep_hours", value: 7, occurred_at: isoDaysAgo(1) }, // ignored
];
const steps = computeStepSummary(stepMetrics, 7000);
assert.equal(steps.daily.length, 7, "7-day window always");
assert.ok(steps.avg > 0, "average is positive");
assert.equal(steps.hitDays, 2, "two days hit 7k target");
assert.equal(steps.missedDays, 5, "five days under target (including zero-fill)");

const emptySteps = computeStepSummary([]);
assert.equal(emptySteps.avg, 0);
assert.equal(emptySteps.daily.length, 7);

// -----------------------------------------------------------------------------
// findMoodTriggers
// -----------------------------------------------------------------------------

const triggerWellness = [];
const triggerFoods = [];
const triggerLedger = [];

// 3 low mood days with heavy delivery counts
for (const dayOffset of [1, 3, 5]) {
  triggerWellness.push({ mood_score: 3, note: "rough day", occurred_at: isoDaysAgo(dayOffset, 21) });
  for (let m = 0; m < 4; m++) {
    triggerFoods.push({
      description: `Swiggy order ${m}`,
      meal_name: "snack",
      protein_g: 5,
      occurred_at: isoDaysAgo(dayOffset, 12 + m),
    });
  }
  triggerLedger.push({
    direction: "expense",
    amount: 4000,
    occurred_at: isoDaysAgo(dayOffset, 13),
  });
}
// Happy days with home-cooked food, low spend.
for (const dayOffset of [2, 4, 6]) {
  triggerWellness.push({ mood_score: 8, note: "great", occurred_at: isoDaysAgo(dayOffset, 21) });
  triggerFoods.push({
    description: "home cooked dal rice",
    meal_name: "lunch",
    protein_g: 30,
    occurred_at: isoDaysAgo(dayOffset, 13),
  });
  triggerLedger.push({
    direction: "expense",
    amount: 200,
    occurred_at: isoDaysAgo(dayOffset, 13),
  });
}

const triggers = findMoodTriggers({
  wellnessLogs: triggerWellness,
  foodLogs: triggerFoods,
  ledger: triggerLedger,
  days: 14,
});
assert.ok(Array.isArray(triggers), "returns array");
assert.ok(triggers.length >= 1, "should detect at least one trigger");
const deliveryTrigger = triggers.find((t) => t.trigger.includes("food deliveries"));
assert.ok(deliveryTrigger, "delivery trigger detected");
assert.ok(deliveryTrigger.score > 0, "trigger has positive score");
assert.ok(Array.isArray(deliveryTrigger.sample_days), "sample_days is array");
assert.ok(deliveryTrigger.sample_days.length >= 1, "has sample days");

const emptyTriggers = findMoodTriggers({});
assert.deepEqual(emptyTriggers, [], "empty input → empty result");

// -----------------------------------------------------------------------------
// computeRecovery
// -----------------------------------------------------------------------------

assert.equal(typeof computeRecovery({ sleepHours: 8, soreness1to5: 1 }), "number");
assert.ok(computeRecovery({ sleepHours: 8, soreness1to5: 1, restingHRV: 80 }) >= 90, "great inputs → high");
assert.ok(computeRecovery({ sleepHours: 4, soreness1to5: 5, restingHRV: 25 }) <= 20, "wrecked inputs → low");
assert.ok(computeRecovery({ sleepHours: 6, soreness1to5: 3 }) > 30, "mid inputs → mid");
assert.ok(computeRecovery({}) >= 0, "no inputs still 0-100");
const bounded = computeRecovery({ sleepHours: 12, soreness1to5: 0, restingHRV: 200 });
assert.ok(bounded <= 100, "score clamped to 100");

// -----------------------------------------------------------------------------
// composeWeeklyReview
// -----------------------------------------------------------------------------

const weekStart = new Date(Date.now() - 7 * DAY_MS);
weekStart.setUTCHours(0, 0, 0, 0);

const review = composeWeeklyReview({
  weekStart: weekStart.toISOString(),
  ledger,
  foodLogs,
  wellnessLogs,
  bodyMetrics,
});
assert.ok(Array.isArray(review.moneyHighlights), "money highlights array");
assert.ok(Array.isArray(review.dietHighlights), "diet highlights array");
assert.ok(Array.isArray(review.wellnessHighlights), "wellness highlights array");
assert.equal(typeof review.score, "number", "score is numeric");
assert.equal(typeof review.oneLiner, "string", "oneLiner is string");
assert.ok(review.oneLiner.length > 10, "oneLiner is non-trivial");
assert.ok(review.moneyHighlights.length >= 1);
assert.ok(review.dietHighlights.length >= 1);
assert.ok(review.wellnessHighlights.length >= 1);

const emptyReview = composeWeeklyReview({ weekStart: weekStart.toISOString() });
assert.equal(typeof emptyReview.oneLiner, "string");
assert.equal(typeof emptyReview.score, "number");

console.log("wellness-domain tests passed");
