import assert from "node:assert/strict";
import { parseBankSms, looksLikeBankSms, smsToCaptureText } from "../src/imports/sms-parser.js";

// Debit with balance - must not read the balance as the amount.
const debit = parseBankSms("Rs.500.00 debited from a/c **1234 on 12-06-24 to SWIGGY UPI Ref 401234567890. Avl Bal Rs.10,000.00");
assert.equal(debit.ok, true);
assert.equal(debit.amount, 500);
assert.equal(debit.direction, "expense");
assert.equal(debit.accountSuffix, "1234");
assert.equal(debit.reference, "401234567890");
assert.equal(debit.balance, 10000);
assert.ok(/swiggy/i.test(debit.merchant), `merchant was ${debit.merchant}`);

// Credit / salary.
const credit = parseBankSms("INR 50,000 credited to A/c XX5678 on 01-Jun. Info: SALARY");
assert.equal(credit.amount, 50000);
assert.equal(credit.direction, "income");
assert.equal(credit.accountSuffix, "5678");

// Card spend.
const card = parseBankSms("Rs 99 spent on HDFC Bank Card xx4321 at NETFLIX");
assert.equal(card.amount, 99);
assert.equal(card.direction, "expense");
assert.ok(/netflix/i.test(card.merchant));

// Detection gate + non-SMS text.
assert.equal(looksLikeBankSms("Rs.500 debited from a/c x1234 at Swiggy"), true);
assert.equal(looksLikeBankSms("had lunch with friends, felt good"), false);
assert.equal(parseBankSms("just a normal note").ok, false);

// Capture-string normalization stays grounded in the parsed figures.
const text = smsToCaptureText(debit);
assert.ok(text.includes("500") && /swiggy/i.test(text));

console.log("sms-parser tests passed");
