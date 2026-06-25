import assert from "node:assert/strict";
import { mapAspirationToTargets, revertTarget } from "../lib/aspiration-cascade.mjs";

// (1) "save 50k this month" -> monthly_spend amount 50000.
const save = mapAspirationToTargets("save 50k this month");
const spend = save.find((c) => c.kind === "monthly_spend");
assert.ok(spend, "monthly_spend change emitted");
assert.equal(spend.amount, 50000, "50k parsed to 50000");

// (2) "lean bulk to 90kg" -> both daily_calories and daily_protein raised.
const bulk = mapAspirationToTargets("lean bulk to 90kg");
const bulkCal = bulk.find((c) => c.kind === "daily_calories");
const bulkPro = bulk.find((c) => c.kind === "daily_protein");
assert.ok(bulkCal, "daily_calories change");
assert.ok(bulkPro, "daily_protein change");
assert.equal(bulkCal.reason, "bulk");
assert.ok(bulkCal.amount > 2000, "calories raised above default");
assert.ok(bulkPro.amount > 162, "protein raised above default");

// (3) "lose weight" -> daily_calories cut.
const cut = mapAspirationToTargets("I want to lose weight");
const cutCal = cut.find((c) => c.kind === "daily_calories");
assert.ok(cutCal, "daily_calories change");
assert.equal(cutCal.reason, "cut");
assert.ok(cutCal.amount < 2000, "calories cut below default");

// (4) "gym 5x a week" -> weekly_workouts amount 5.
const gym = mapAspirationToTargets("gym 5x a week");
const freq = gym.find((c) => c.kind === "weekly_workouts");
assert.ok(freq, "weekly_workouts change");
assert.equal(freq.amount, 5, "frequency parsed");

// (5) non-goal text -> [].
assert.deepEqual(mapAspirationToTargets("had a great day"), []);

// (6) revertTarget math.
assert.deepEqual(revertTarget(null), { action: "delete" });
assert.deepEqual(revertTarget(45000), { action: "upsert", amount: 45000 });

console.log("memory-cascade tests passed");
