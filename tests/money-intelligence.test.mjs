// Wave 3 money intelligence test suite.
// Standalone node script - run with `node tests/money-intelligence.test.mjs`.
// Covers bank-format-detector, column-candidates, transfer-detector,
// refund-matcher, subscription-detector, budget-alerts, merchant-aliases.

import assert from "node:assert/strict";

import {
  detectBankFormat,
  bankSignature,
  KNOWN_BANK_KEYS,
} from "../src/imports/bank-format-detector.js";
import {
  columnCandidates,
  autoMapColumns,
  mappingConfidence,
} from "../src/imports/column-candidates.js";
import { detectTransfers } from "../src/domain/money/transfer-detector.js";
import { matchRefunds } from "../src/domain/money/refund-matcher.js";
import { detectSubscriptions } from "../src/domain/money/subscription-detector.js";
import { computeBudgetAlerts } from "../src/domain/money/budget-alerts.js";
import { resolveMerchant } from "../src/domain/money/merchant-aliases.js";

let assertions = 0;
function check(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assertions += 1;
}
function checkEq(actual, expected, label) {
  assert.equal(actual, expected, label);
  assertions += 1;
}
function checkTrue(actual, label) {
  assert.ok(actual, label);
  assertions += 1;
}

// ---------------------------------------------------------------------------
// 1. bank-format-detector
// ---------------------------------------------------------------------------

// Known signature keys exposed for downstream UI.
checkTrue(Array.isArray(KNOWN_BANK_KEYS) && KNOWN_BANK_KEYS.length >= 18,
  "KNOWN_BANK_KEYS exposes 18+ entries");
checkTrue(KNOWN_BANK_KEYS.includes("hdfc"), "KNOWN_BANK_KEYS has hdfc");
checkTrue(KNOWN_BANK_KEYS.includes("hdfc_cc"), "KNOWN_BANK_KEYS has hdfc_cc");

// HDFC savings/current account filename.
checkEq(detectBankFormat({ filename: "hdfc-may-2026.xlsx" }), "hdfc",
  "HDFC current account from filename");

// HDFC credit card statement (more specific match must win).
checkEq(detectBankFormat({ filename: "HDFC Credit Card statement May.pdf" }), "hdfc_cc",
  "HDFC credit card statement");

// ICICI savings vs credit card.
checkEq(detectBankFormat({ filename: "icici-savings.csv" }), "icici",
  "ICICI savings");
checkEq(detectBankFormat({ filename: "icici credit card 04-2026.xls" }), "icici_cc",
  "ICICI credit card");

// SBI savings + SBI card.
checkEq(detectBankFormat({ filename: "sbi-statement.csv" }), "sbi",
  "SBI savings via abbreviation");
checkEq(detectBankFormat({ sampleText: "State Bank of India - account statement" }), "sbi",
  "SBI savings via sampleText");
checkEq(detectBankFormat({ filename: "sbi-card-april.pdf" }), "sbi_cc",
  "SBI credit card");

// Axis.
checkEq(detectBankFormat({ filename: "axis-bank-2026.xlsx" }), "axis",
  "Axis savings");

// Kotak.
checkEq(detectBankFormat({ filename: "kotak-mahindra-feb.csv" }), "kotak",
  "Kotak");

// IndusInd.
checkEq(detectBankFormat({ filename: "indusind-bank-statement.xlsx" }), "indusind",
  "IndusInd");

// Bank of Baroda - both abbreviation and full name.
checkEq(detectBankFormat({ filename: "bob-may.csv" }), "bob",
  "Bank of Baroda via BOB");
checkEq(detectBankFormat({ sampleText: "Bank of Baroda credit summary" }), "bob",
  "Bank of Baroda via long name");

// PNB.
checkEq(detectBankFormat({ filename: "pnb-jan.csv" }), "pnb",
  "PNB via abbreviation");
checkEq(detectBankFormat({ sampleText: "Punjab National Bank monthly" }), "pnb",
  "PNB via full name");

// Yes Bank.
checkEq(detectBankFormat({ filename: "yesbank-2026.csv" }), "yes",
  "Yes Bank via yesbank token");
checkEq(detectBankFormat({ sampleText: "Yes Bank account summary" }), "yes",
  "Yes Bank via full name");

// IDFC.
checkEq(detectBankFormat({ filename: "idfc-first-bank.xlsx" }), "idfc",
  "IDFC First Bank");

// Amex.
checkEq(detectBankFormat({ filename: "amex-may.pdf" }), "amex",
  "Amex short");
checkEq(detectBankFormat({ sampleText: "AMERICAN EXPRESS card statement" }), "amex",
  "Amex via full name");

// Wallets / fintech.
checkEq(detectBankFormat({ filename: "paytm-postpaid.csv" }), "paytm",
  "Paytm wallet");
checkEq(detectBankFormat({ filename: "amazonpay-history.csv" }), "amazonpay",
  "Amazon Pay");
checkEq(detectBankFormat({ filename: "phonepe-wallet-export.csv" }), "phonepe_wallet",
  "PhonePe wallet");

// RBL + Citi.
checkEq(detectBankFormat({ filename: "rbl-card-may.csv" }), "rbl",
  "RBL");
checkEq(detectBankFormat({ filename: "citibank-statement.pdf" }), "citi",
  "Citi via citibank");

// Fallback.
checkEq(detectBankFormat({ filename: "random-merchant-export.csv" }), "unknown",
  "Unknown fallback");
checkEq(detectBankFormat({}), "unknown",
  "Empty input falls back to unknown");

// bankSignature is stable across header order shuffles + casing + whitespace.
const sigA = bankSignature(["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]);
const sigB = bankSignature(["Closing Balance", "deposit amt.", "DATE", "withdrawal amt.", "  Narration  "]);
checkEq(sigA, sigB, "bankSignature stable across reordering/casing/whitespace");
checkTrue(sigA.length > 0, "bankSignature returns non-empty fingerprint");

// ---------------------------------------------------------------------------
// 2. column-candidates
// ---------------------------------------------------------------------------

// HDFC-style spec header row maps every field we need.
const hdfcMap = autoMapColumns([
  "Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance", "Ref No.",
]);
checkEq(hdfcMap.date, "Date", "HDFC header -> date");
checkEq(hdfcMap.description, "Narration", "HDFC header -> description");
checkEq(hdfcMap.debit, "Withdrawal Amt.", "HDFC header -> debit");
checkEq(hdfcMap.credit, "Deposit Amt.", "HDFC header -> credit");
checkEq(hdfcMap.balance, "Closing Balance", "HDFC header -> balance");
checkEq(hdfcMap.reference, "Ref No.", "HDFC header -> reference");

// columnCandidates structure sanity.
checkTrue(Array.isArray(columnCandidates.date), "columnCandidates.date is array");
checkTrue(columnCandidates.amount.length > 0, "columnCandidates.amount populated");

// Abbreviations "Dr"/"Cr".
const drCrMap = autoMapColumns(["Date", "Description", "Dr", "Cr", "Balance"]);
checkEq(drCrMap.debit, "Dr", "Abbreviated Dr maps to debit");
checkEq(drCrMap.credit, "Cr", "Abbreviated Cr maps to credit");

// Uppercase headers still resolved.
const upperMap = autoMapColumns(["DATE", "NARRATION", "AMOUNT", "BALANCE"]);
checkEq(upperMap.date, "DATE", "Uppercase DATE maps to date");
checkEq(upperMap.description, "NARRATION", "Uppercase NARRATION maps to description");
checkEq(upperMap.amount, "AMOUNT", "Uppercase AMOUNT maps to amount");

// Unicode rupee symbol in header.
const rupeeMap = autoMapColumns(["Date", "Particulars", "Debit ₹", "Credit ₹", "Balance ₹"]);
checkEq(rupeeMap.debit, "Debit ₹", "Unicode rupee debit header normalized");
checkEq(rupeeMap.credit, "Credit ₹", "Unicode rupee credit header normalized");
checkEq(rupeeMap.balance, "Balance ₹", "Unicode rupee balance header normalized");

// Missing required field -> low confidence.
checkEq(mappingConfidence({}), 0, "Empty mapping -> zero confidence");
checkEq(mappingConfidence({ date: "Date" }), 0,
  "Missing description -> zero confidence");
checkEq(mappingConfidence({ date: "Date", description: "Narration" }), 0.3,
  "Date+description but no money -> 0.3");
checkEq(mappingConfidence({ date: "Date", description: "Narration", amount: "Amount" }), 1,
  "Date+description+amount -> 1");
checkEq(mappingConfidence({
  date: "D", description: "N", debit: "Dr", credit: "Cr",
}), 1, "Date+description+debit+credit -> 1");

// Full mapping from spec header row is high confidence.
checkEq(mappingConfidence(hdfcMap), 1, "HDFC mapping is fully confident");

// ---------------------------------------------------------------------------
// 3. transfer-detector
// ---------------------------------------------------------------------------

// Debit ₹5000 on day D + credit ₹5000 on day D+1 on a different account -> pair.
const transferRows = [
  { id: "d1", direction: "expense", amount: 5000, account: "hdfc-sav",
    description: "Transfer to ICICI", occurred_at: "2026-05-10T10:00:00+05:30" },
  { id: "c1", direction: "income",  amount: 5000, account: "icici-sav",
    description: "Received from HDFC", occurred_at: "2026-05-11T09:30:00+05:30" },
];
const pairs = detectTransfers(transferRows);
checkEq(pairs.length, 1, "Cross-account same-amount D and D+1 produce 1 pair");
checkEq(pairs[0].debit.id, "d1", "Pair contains the debit row");
checkEq(pairs[0].credit.id, "c1", "Pair contains the credit row");
checkEq(pairs[0].reason, "paired_accounts", "Reason is paired_accounts");

// Two debits never pair.
const twoDebits = [
  { id: "d1", direction: "expense", amount: 1000, account: "a",
    description: "lunch", occurred_at: "2026-05-10T10:00:00+05:30" },
  { id: "d2", direction: "expense", amount: 1000, account: "b",
    description: "lunch", occurred_at: "2026-05-10T11:00:00+05:30" },
];
checkEq(detectTransfers(twoDebits).length, 0, "Two debits never pair");

// Mismatching amount > 1 INR doesn't pair.
const amountMismatch = [
  { id: "d", direction: "expense", amount: 5000, account: "a",
    description: "NEFT", occurred_at: "2026-05-10T10:00:00+05:30" },
  { id: "c", direction: "income", amount: 4990, account: "b",
    description: "NEFT credit", occurred_at: "2026-05-11T10:00:00+05:30" },
];
checkEq(detectTransfers(amountMismatch).length, 0,
  "Mismatching amounts beyond 1 INR don't pair");

// Within 1 INR rounding does pair (tolerance check).
const roundingPair = [
  { id: "d", direction: "expense", amount: 5000.00, account: "a",
    description: "NEFT to self", occurred_at: "2026-05-10T10:00:00+05:30" },
  { id: "c", direction: "income",  amount: 4999.50, account: "b",
    description: "NEFT credit",   occurred_at: "2026-05-11T10:00:00+05:30" },
];
checkEq(detectTransfers(roundingPair).length, 1,
  "Amounts within 1 INR tolerance do pair");

// Keyword detection on the same account uses transfer_keyword.
const keywordRows = [
  { id: "d1", direction: "expense", amount: 1200, account: "hdfc",
    description: "NEFT to self HDFC", occurred_at: "2026-05-10T10:00:00+05:30" },
  { id: "c1", direction: "income",  amount: 1200, account: "hdfc",
    description: "IMPS credit", occurred_at: "2026-05-10T18:00:00+05:30" },
];
const keywordPairs = detectTransfers(keywordRows);
checkEq(keywordPairs.length, 1, "Keyword on same account still pairs");
checkEq(keywordPairs[0].reason, "transfer_keyword",
  "Reason is transfer_keyword for NEFT/IMPS phrasing");

// UPI transfer keyword.
const upiRows = [
  { id: "d", direction: "expense", amount: 250, account: "hdfc",
    description: "UPI transfer to self", occurred_at: "2026-05-10T10:00:00+05:30" },
  { id: "c", direction: "income", amount: 250, account: "hdfc",
    description: "UPI received", occurred_at: "2026-05-10T11:00:00+05:30" },
];
checkEq(detectTransfers(upiRows)[0].reason, "transfer_keyword",
  "UPI transfer keyword recognized");

// Out-of-window time difference does not pair (beyond 36 hours).
const wideWindow = [
  { id: "d", direction: "expense", amount: 1000, account: "a",
    description: "Transfer", occurred_at: "2026-05-01T10:00:00+05:30" },
  { id: "c", direction: "income",  amount: 1000, account: "b",
    description: "Received", occurred_at: "2026-05-05T10:00:00+05:30" },
];
checkEq(detectTransfers(wideWindow).length, 0,
  "Beyond 36-hour window, no pair");

// ---------------------------------------------------------------------------
// 4. refund-matcher
// ---------------------------------------------------------------------------

// Zomato refund 7 days after a matching debit -> pair.
const refundRows = [
  { id: "e1", direction: "expense", amount: 540, merchant: "Zomato",
    occurred_at: "2026-05-01T13:00:00+05:30" },
  { id: "r1", direction: "income",  amount: 540, merchant: "Zomato",
    occurred_at: "2026-05-08T10:00:00+05:30" },
];
const refundPairs = matchRefunds(refundRows);
checkEq(refundPairs.length, 1, "Matching Zomato refund pairs with debit");
checkEq(refundPairs[0].original.id, "e1", "Original debit preserved");
checkEq(refundPairs[0].refund.id, "r1", "Refund credit preserved");
checkTrue(refundPairs[0].score >= 0.55, "Pair score above threshold");

// Wrong merchant -> no pair.
const wrongMerchant = [
  { id: "e", direction: "expense", amount: 540, merchant: "Swiggy",
    occurred_at: "2026-05-01T13:00:00+05:30" },
  { id: "r", direction: "income",  amount: 540, merchant: "Zomato",
    occurred_at: "2026-05-08T10:00:00+05:30" },
];
checkEq(matchRefunds(wrongMerchant).length, 0,
  "Different merchant doesn't pair");

// Refund > 60 days after debit -> excluded.
const tooOld = [
  { id: "e", direction: "expense", amount: 540, merchant: "Zomato",
    occurred_at: "2026-01-01T13:00:00+05:30" },
  { id: "r", direction: "income",  amount: 540, merchant: "Zomato",
    occurred_at: "2026-05-01T10:00:00+05:30" },
];
checkEq(matchRefunds(tooOld).length, 0,
  "Refund beyond 60 days is excluded");

// Partial refund within 5% tolerance -> pairs.
const partialRefund = [
  { id: "e", direction: "expense", amount: 1000, merchant: "Amazon",
    occurred_at: "2026-05-01T13:00:00+05:30" },
  { id: "r", direction: "income",  amount: 970, merchant: "Amazon",
    occurred_at: "2026-05-05T10:00:00+05:30" },
];
const partials = matchRefunds(partialRefund);
checkEq(partials.length, 1, "Partial refund within 5% tolerance pairs");
checkEq(partials[0].original.id, "e", "Partial refund pairs with the right debit");

// Refund preceding the debit chronologically is not eligible.
const refundBeforeDebit = [
  { id: "e", direction: "expense", amount: 540, merchant: "Zomato",
    occurred_at: "2026-05-10T13:00:00+05:30" },
  { id: "r", direction: "income",  amount: 540, merchant: "Zomato",
    occurred_at: "2026-05-01T10:00:00+05:30" },
];
checkEq(matchRefunds(refundBeforeDebit).length, 0,
  "Refund before debit ignored");

// ---------------------------------------------------------------------------
// 5. subscription-detector
// ---------------------------------------------------------------------------

// Four monthly Netflix charges at ~₹649 cluster.
const netflixRows = [
  { id: "n1", direction: "expense", amount: 649, merchant: "Netflix",
    occurred_at: "2026-02-05T08:00:00+05:30" },
  { id: "n2", direction: "expense", amount: 649, merchant: "Netflix",
    occurred_at: "2026-03-07T08:00:00+05:30" },
  { id: "n3", direction: "expense", amount: 649, merchant: "Netflix",
    occurred_at: "2026-04-06T08:00:00+05:30" },
  { id: "n4", direction: "expense", amount: 649, merchant: "Netflix",
    occurred_at: "2026-05-06T08:00:00+05:30" },
];
const subs = detectSubscriptions(netflixRows);
checkEq(subs.length, 1, "Netflix cluster yields exactly one subscription");
checkEq(subs[0].sample_count, 4, "Subscription sample count is 4");
checkEq(subs[0].median_amount, 649, "Subscription median amount is 649");
checkTrue(subs[0].cadence_days >= 28 && subs[0].cadence_days <= 32,
  "Subscription cadence ~30 days");
const lastSeen = new Date(subs[0].last_seen_at).getTime();
const nextAt = new Date(subs[0].next_expected_at).getTime();
const dayDiff = (nextAt - lastSeen) / 86_400_000;
checkTrue(dayDiff > 28 && dayDiff < 32,
  "next_expected_at is ~30 days after last charge");
checkEq(subs[0].member_ids.length, 4, "Subscription member_ids has all 4 ids");

// Only two occurrences -> not a subscription.
const twoNetflix = [
  { id: "n1", direction: "expense", amount: 649, merchant: "Netflix",
    occurred_at: "2026-04-06T08:00:00+05:30" },
  { id: "n2", direction: "expense", amount: 649, merchant: "Netflix",
    occurred_at: "2026-05-06T08:00:00+05:30" },
];
checkEq(detectSubscriptions(twoNetflix).length, 0,
  "Two occurrences don't qualify as subscription");

// Wildly varying amounts don't cluster.
const noisyRows = [
  { id: "x1", direction: "expense", amount: 100,  merchant: "GenericShop",
    occurred_at: "2026-02-05T08:00:00+05:30" },
  { id: "x2", direction: "expense", amount: 500,  merchant: "GenericShop",
    occurred_at: "2026-03-07T08:00:00+05:30" },
  { id: "x3", direction: "expense", amount: 2000, merchant: "GenericShop",
    occurred_at: "2026-04-06T08:00:00+05:30" },
  { id: "x4", direction: "expense", amount: 5000, merchant: "GenericShop",
    occurred_at: "2026-05-06T08:00:00+05:30" },
];
checkEq(detectSubscriptions(noisyRows).length, 0,
  "Wildly varying amounts don't cluster");

// Credits are ignored.
const creditsIgnored = [
  { id: "c1", direction: "income", amount: 649, merchant: "Netflix",
    occurred_at: "2026-02-05T08:00:00+05:30" },
  { id: "c2", direction: "income", amount: 649, merchant: "Netflix",
    occurred_at: "2026-03-07T08:00:00+05:30" },
  { id: "c3", direction: "income", amount: 649, merchant: "Netflix",
    occurred_at: "2026-04-06T08:00:00+05:30" },
];
checkEq(detectSubscriptions(creditsIgnored).length, 0,
  "Income rows are not treated as subscriptions");

// ---------------------------------------------------------------------------
// 6. budget-alerts
// ---------------------------------------------------------------------------

const midMonth = new Date("2026-05-22T12:00:00+05:30");
const earlyMonth = new Date("2026-05-05T12:00:00+05:30");

function spend(id, amount, occurred_at, category_id) {
  return { id, direction: "expense", amount, occurred_at, category_id };
}

// Exceeded.
const exceededAlerts = computeBudgetAlerts({
  ledger: [spend("a", 1200, "2026-05-10T10:00:00+05:30")],
  budgets: [{ id: "b-total", amount: 1000, period: "monthly" }],
  today: midMonth,
});
checkEq(exceededAlerts.length, 1, "Exceeded produces one alert");
checkEq(exceededAlerts[0].severity, "exceeded", "Severity is exceeded");

// Critical (>= 90% but <100%).
const criticalAlerts = computeBudgetAlerts({
  ledger: [spend("a", 950, "2026-05-10T10:00:00+05:30")],
  budgets: [{ id: "b-total", amount: 1000, period: "monthly" }],
  today: midMonth,
});
checkEq(criticalAlerts[0].severity, "critical",
  "Severity is critical at 95%");

// Warning (75-90%).
const warningAlerts = computeBudgetAlerts({
  ledger: [spend("a", 800, "2026-05-10T10:00:00+05:30")],
  budgets: [{ id: "b-total", amount: 1000, period: "monthly" }],
  today: midMonth,
});
checkEq(warningAlerts[0].severity, "warning",
  "Severity is warning at 80%");

// Pace early in the month (mid-month pace alert).
const paceAlerts = computeBudgetAlerts({
  ledger: [spend("a", 600, "2026-05-03T10:00:00+05:30")],
  budgets: [{ id: "b-total", amount: 1000, period: "monthly" }],
  today: earlyMonth,
});
checkEq(paceAlerts[0].severity, "pace",
  "Spending ahead of pace early in month -> pace severity");
checkTrue(paceAlerts[0].pct_spent > paceAlerts[0].pct_elapsed,
  "pace alert has pct_spent above pct_elapsed");

// OK -> suppressed from output.
const okAlerts = computeBudgetAlerts({
  ledger: [spend("a", 100, "2026-05-10T10:00:00+05:30")],
  budgets: [{ id: "b-total", amount: 1000, period: "monthly" }],
  today: midMonth,
});
checkEq(okAlerts.length, 0, "ok severity is suppressed");

// Sort order: exceeded before warning.
const sortedAlerts = computeBudgetAlerts({
  ledger: [
    spend("a", 800, "2026-05-10T10:00:00+05:30", "cat-food"),
    spend("b", 1200, "2026-05-10T10:00:00+05:30", "cat-shop"),
  ],
  budgets: [
    { id: "b1", amount: 1000, period: "monthly", category_id: "cat-food" },
    { id: "b2", amount: 1000, period: "monthly", category_id: "cat-shop" },
  ],
  today: midMonth,
});
checkEq(sortedAlerts.length, 2, "Two alerts emitted");
checkEq(sortedAlerts[0].severity, "exceeded",
  "Sorted: exceeded comes before warning");
checkEq(sortedAlerts[1].severity, "warning",
  "Sorted: warning comes second");

// Category-scoped budget ignores other categories.
const categoryScoped = computeBudgetAlerts({
  ledger: [
    spend("a", 950, "2026-05-10T10:00:00+05:30", "cat-food"),
    spend("b", 800, "2026-05-10T10:00:00+05:30", "cat-shop"),
  ],
  budgets: [
    { id: "b-food", amount: 1000, period: "monthly", category_id: "cat-food" },
  ],
  today: midMonth,
});
checkEq(categoryScoped.length, 1, "Category scoped budget produces one alert");
checkEq(categoryScoped[0].category_id, "cat-food",
  "Alert carries the scoped category id");
checkEq(categoryScoped[0].severity, "critical",
  "Category scoped severity is critical at 95%");

// Total (unscoped) budget aggregates across all categories.
const totalBudget = computeBudgetAlerts({
  ledger: [
    spend("a", 700, "2026-05-10T10:00:00+05:30", "cat-food"),
    spend("b", 400, "2026-05-10T10:00:00+05:30", "cat-shop"),
  ],
  budgets: [
    { id: "b-total", amount: 1000, period: "monthly" },
  ],
  today: midMonth,
});
checkEq(totalBudget[0].severity, "exceeded",
  "Total budget sums across all categories -> exceeded");
checkEq(totalBudget[0].category_id, null,
  "Total budget alert has null category_id");

// Items outside the period start are ignored.
const oldSpend = computeBudgetAlerts({
  ledger: [spend("a", 1200, "2026-04-15T10:00:00+05:30")],
  budgets: [{ id: "b-total", amount: 1000, period: "monthly" }],
  today: midMonth,
});
checkEq(oldSpend.length, 0,
  "Spend before period start is excluded from the alert");

// ---------------------------------------------------------------------------
// 7. merchant-aliases
// ---------------------------------------------------------------------------

// Built-in canonicalizations (10+ distinct examples).
checkEq(resolveMerchant("ZOMATO LTD").canonical, "zomato",
  "ZOMATO LTD canonicalizes to zomato");
checkEq(resolveMerchant("Zomato UPI").canonical, "zomato",
  "Zomato UPI canonicalizes to zomato");
checkEq(resolveMerchant("UPI-SWIGGY*ORDER").canonical, "swiggy",
  "Swiggy UPI order canonicalizes to swiggy");
checkEq(resolveMerchant("AMAZON PAY INDIA PVT LTD").canonical, "amazon",
  "Amazon Pay India canonicalizes to amazon");
checkEq(resolveMerchant("AMZN MKTPLACE").canonical, "amazon",
  "AMZN MKTPLACE canonicalizes to amazon");
checkEq(resolveMerchant("FLIPKART INTERNET PVT LTD").canonical, "flipkart",
  "Flipkart canonicalizes");
checkEq(resolveMerchant("UBER INDIA SYSTEMS").canonical, "uber",
  "Uber canonicalizes");
checkEq(resolveMerchant("OLACABS").canonical, "ola",
  "Olacabs canonicalizes to ola");
checkEq(resolveMerchant("NETFLIX SUBSCRIPTION").canonical, "netflix",
  "Netflix canonicalizes");
checkEq(resolveMerchant("Spotify India").canonical, "spotify",
  "Spotify canonicalizes");
checkEq(resolveMerchant("Bigbasket Daily").canonical, "bigbasket",
  "Bigbasket canonicalizes");
checkEq(resolveMerchant("BLINKIT GROCERY").canonical, "blinkit",
  "Blinkit canonicalizes");
checkEq(resolveMerchant("DOMINOS PIZZA").canonical, "dominos",
  "Dominos canonicalizes");

// Source classification is "builtin".
checkEq(resolveMerchant("Zomato").source, "builtin",
  "Built-in match has source=builtin");

// User alias takes precedence over builtin.
const userResult = resolveMerchant("Zomato UPI", {
  userAliases: [{ alias: "zomato", canonical: "food-delivery" }],
});
checkEq(userResult.canonical, "food-delivery",
  "User alias overrides builtin canonical");
checkEq(userResult.source, "user",
  "User alias source is reported");

// Fallback returns the cleaned raw string for unknown merchants.
const fallback = resolveMerchant("Random Local Shop 42");
checkEq(fallback.source, "fallback", "Unknown merchant -> source=fallback");
checkEq(fallback.canonical, "random local shop 42",
  "Fallback returns the cleaned raw string");

// Empty input is handled gracefully.
const emptyResult = resolveMerchant("");
checkEq(emptyResult.canonical, null, "Empty merchant -> canonical=null");
checkEq(emptyResult.source, "none", "Empty merchant -> source=none");

// ---------------------------------------------------------------------------
console.log(`money-intelligence tests passed: ${assertions} assertions`);
