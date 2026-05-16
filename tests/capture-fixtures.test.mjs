import assert from "node:assert/strict";
import {
  classifyCaptureInput,
  classifyImportColumns,
  routeModelForCapture,
  scoreExpenseDuplicate,
  validateToolAction,
} from "../lib/agent-core.mjs";

const captureCases = [
  ["paid 240 zomato on gpay", "money"],
  ["PhonePe screenshot dump from today", "money"],
  ["UPI to Rahul 900 for dinner split", "money"],
  ["refund from amazon 1299 credited", "money"],
  ["ate poha chai breakfast and dal rice lunch", "diet"],
  ["protein was low, had eggs and paneer", "diet"],
  ["dinner chicken rice and curd", "diet"],
  ["slept 5h 40m and walked 8500 steps", "wellness"],
  ["gym push day bench 50x8", "wellness"],
  ["mood low, stress high after work", "wellness"],
  ["uploading May bank statement excel", "file_import"],
  ["credit card pdf statement import", "file_import"],
  ["csv bank export from hdfc", "file_import"],
  ["weekly log: paid zomato and fuel, lunch dal rice", "money"],
  ["monthly dump from notes app: bank rows and diet summary", "file_import"],
  ["random thought about life", "general_note"],
];

for (const [text, expected] of captureCases) {
  assert.equal(classifyCaptureInput({ text }), expected, text);
}

const fileCases = [
  [[{ name: "hdfc-may.xlsx" }], "file_import"],
  [[{ name: "icici-card.pdf" }], "file_import"],
  [[{ name: "phonepe.png", kind: "image" }], "media_review"],
  [[{ name: "voice-note.webm", kind: "audio" }], "media_review"],
];

for (const [files, expected] of fileCases) {
  assert.equal(classifyCaptureInput({ files }), expected, JSON.stringify(files));
}

const importMappings = [
  {
    headers: ["Date", "Narration", "Debit", "Credit", "Balance"],
    expected: { date: "Date", description: "Narration", debit: "Debit", credit: "Credit", balance: "Balance" },
  },
  {
    headers: ["Txn Date", "Particulars", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance", "UTR"],
    expected: { date: "Txn Date", description: "Particulars", balance: "Closing Balance", reference: "UTR" },
  },
  {
    headers: ["Posted Date", "Merchant", "Transaction Amount"],
    expected: { date: "Posted Date", description: "Merchant", amount: "Transaction Amount" },
  },
];

for (const { headers, expected } of importMappings) {
  const actual = classifyImportColumns(headers);
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(actual[field], value, `${field} for ${headers.join(", ")}`);
  }
}

const duplicatePairs = [
  {
    a: { amount: 500, merchant: "Indian Oil UPI", occurredAt: "2026-05-11T10:00:00+05:30", direction: "expense" },
    b: { amount: 500, merchant: "INDIAN OIL", occurredAt: "2026-05-11T10:04:00+05:30", direction: "expense" },
    duplicate: true,
  },
  {
    a: { amount: 240, merchant: "Zomato", occurredAt: "2026-05-10T20:00:00+05:30", direction: "expense" },
    b: { amount: 240, merchant: "Zomato", occurredAt: "2026-05-11T20:00:00+05:30", direction: "expense" },
    duplicate: false,
  },
  {
    a: { amount: 1299, merchant: "Amazon", occurredAt: "2026-05-01T12:00:00+05:30", direction: "expense", reference: "ABC" },
    b: { amount: 1299, merchant: "Amazon India", occurredAt: "2026-05-04T12:00:00+05:30", direction: "expense", reference: "ABC" },
    duplicate: true,
  },
];

for (const pair of duplicatePairs) {
  assert.equal(scoreExpenseDuplicate(pair.a, pair.b).isDuplicate, pair.duplicate);
}

assert.equal(routeModelForCapture({ captureType: "file_import" }).brainModel, "deepseek-ai/deepseek-v4-pro");
assert.equal(routeModelForCapture({ captureType: "media_review" }).mediaModel, "gemini-2.5-flash");

assert.equal(
  validateToolAction({
    name: "delete_everything",
    arguments: {},
    confidence: 1,
  }).ok,
  false,
);

console.log(`capture fixtures passed: ${captureCases.length + fileCases.length + importMappings.length + duplicatePairs.length} cases`);
