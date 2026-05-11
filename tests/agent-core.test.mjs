import assert from "node:assert/strict";
import {
  classifyCaptureInput,
  classifyImportColumns,
  estimateMonthlyAiCost,
  normalizeMerchant,
  routeModelForCapture,
  scoreExpenseDuplicate,
  validateToolAction,
} from "../lib/agent-core.mjs";

const duplicate = scoreExpenseDuplicate(
  {
    amount: "Rs 240.00",
    merchant: "Zomato UPI",
    occurredAt: "2026-05-11T14:20:00+05:30",
    direction: "expense",
    reference: "UPI123",
  },
  {
    amount: 240,
    description: "ZOMATO LTD INDIA",
    occurredAt: "2026-05-11T14:23:00+05:30",
    direction: "expense",
    reference: "UPI123",
  },
);

assert.equal(duplicate.isDuplicate, true);
assert.ok(duplicate.score >= 0.9);
assert.deepEqual(
  ["amount", "same_time_window", "merchant", "reference", "direction"].every((reason) =>
    duplicate.reasons.includes(reason),
  ),
  true,
);

const notDuplicate = scoreExpenseDuplicate(
  {
    amount: 240,
    merchant: "Zomato",
    occurredAt: "2026-05-10T20:00:00+05:30",
    direction: "expense",
  },
  {
    amount: 240,
    merchant: "Zomato",
    occurredAt: "2026-05-11T20:00:00+05:30",
    direction: "expense",
  },
);

assert.equal(notDuplicate.isDuplicate, false);

assert.equal(normalizeMerchant("ZOMATO PVT LTD UPI"), "zomato");

const mapping = classifyImportColumns([
  "Txn Date",
  "Narration",
  "Withdrawal Amt.",
  "Deposit Amt.",
  "Closing Balance",
  "UTR Number",
]);

assert.equal(mapping.date, "Txn Date");
assert.equal(mapping.description, "Narration");
assert.equal(mapping.balance, "Closing Balance");
assert.equal(mapping.reference, "UTR Number");

const cost = estimateMonthlyAiCost({
  imagesPerDay: 15,
  voiceMinutesPerDay: 5,
  agentEventsPerDay: 40,
});

assert.ok(cost.monthlyTotal > 0);
assert.ok(cost.monthlyTotal < 10);

assert.equal(
  classifyCaptureInput({
    text: "uploading my HDFC bank excel statement",
    files: [{ name: "may-statement.xlsx" }],
  }),
  "file_import",
);

assert.equal(classifyCaptureInput({ text: "ate 3 rotis dal rice and curd" }), "diet");
assert.equal(classifyCaptureInput({ text: "paid 500 fuel on gpay" }), "money");
assert.equal(classifyCaptureInput({ text: "slept 5h and walked 8000 steps" }), "wellness");

assert.equal(routeModelForCapture({ captureType: "media_review" }).mediaModel, "gemini-3.1-flash-lite");
assert.equal(routeModelForCapture({ captureType: "media_review", risk: "high" }).mediaModel, "gemini-3.1-pro-preview");
assert.equal(routeModelForCapture({ captureType: "money" }).brainModel, "deepseek-ai/deepseek-v4-pro");

assert.equal(
  validateToolAction({
    name: "create_expense_candidate",
    arguments: { amount: 240, merchant: "Zomato" },
    confidence: 0.91,
  }).ok,
  true,
);

assert.deepEqual(
  validateToolAction({
    name: "create_expense_candidate",
    arguments: { amount: 240 },
    confidence: 0.44,
  }).errors,
  ["low_confidence_must_review"],
);

console.log("agent-core tests passed");
