import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isGrounded, evidenceHasNumber, hasWordOverlap } from "../src/agent/evidence-grounding.js";

// Numbers: standalone match, comma-insensitive, digit-boundary aware.
assert.equal(evidenceHasNumber(240, "Paid Rs 240 to Zomato"), true);
assert.equal(evidenceHasNumber(1240, "balance ₹1,240 after"), true);
assert.equal(evidenceHasNumber(240, "order id 1240xyz"), false, "240 must not match inside 1240");
assert.equal(evidenceHasNumber(82.4, "weight 82.4 kg morning"), true);
assert.equal(evidenceHasNumber(500, ""), false);

// Word overlap.
assert.equal(hasWordOverlap("dal rice curd", "lunch was dal and rice"), true);
assert.equal(hasWordOverlap("paneer tikka", "had veg biryani"), false);

// Grounded expense (amount present) → true; fabricated amount → false.
assert.equal(isGrounded("create_expense_candidate", { amount: 240, merchant: "Zomato" }, "paid 240 zomato"), true);
assert.equal(isGrounded("create_expense_candidate", { amount: 9999, merchant: "Zomato" }, "paid 240 zomato"), false);

// No evidence at all → cannot ground → force review.
assert.equal(isGrounded("create_expense_candidate", { amount: 240 }, ""), false);

// Food grounded by description overlap (e.g. from vision OCR text).
assert.equal(isGrounded("create_food_log_candidate", { description: "dal rice curd" }, "plate of dal, rice, curd"), true);

// Body metric grounded by the numeric value.
assert.equal(isGrounded("create_body_metric_candidate", { metric_type: "weight", value: 82.4 }, "82.4 morning"), true);

// Non-write tools are never gated here.
assert.equal(isGrounded("request_user_review", {}, ""), true);

// The edge function must actually call the guard before auto-applying.
const fn = readFileSync("supabase/functions/agent/index.ts", "utf8");
assert.ok(/isGrounded\(tc\.name, tc\.arguments, evidence\)/.test(fn), "edge function must apply the evidence guard before auto-apply");
assert.ok(/rx\.test\(geminiEvidence\)/.test(fn), "edge function injection check must cover Gemini-extracted OCR/vision text");

console.log("evidence-grounding tests passed");
