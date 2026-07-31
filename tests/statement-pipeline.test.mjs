// The statement pipeline, tested on the exact shapes real Indian bank exports
// have. Every fixture below is the true layout of a file that previously
// imported ZERO rows: the preamble depth, the duplicate "Dr / Cr" header, the
// asterisk rules, the summary footer and the truncated payee names are all
// reproduced rather than idealised.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  shapeStatement, parseAmount, parseStatementDate, detectDayFirst, bindColumns, roleOfHeader, bankFromIfsc,
} from "../lib/statement-shape.mjs";
import { auditStatement, verifyBalanceChain, reconcileDeclared, verifyPeriod } from "../lib/statement-audit.mjs";
import {
  parseNarration, classifyTransaction, buildOwnerIdentity, counterpartyKind, isSpending, FLOW_TYPES,
} from "../lib/txn-semantics.mjs";
import {
  linkSelfTransfers, linkRefunds, detectDuplicateCharges, detectRecurring, matchManualEntries, isoDay,
} from "../lib/statement-link.mjs";
import { ingestStatements, contentKeyOf, accountKeyOf } from "../lib/statement-ingest.mjs";

// ---------------------------------------------------------------------------
// Fixtures - real layouts
// ---------------------------------------------------------------------------

// Kotak CSV: 13 preamble rows, "Dr / Cr" appears TWICE, footer after the rows.
const KOTAK = [
  ["", "", "Account Statement", "", "", "", "", "", ""],
  ["ABHAY ANAND VATSA", "", "", "", "", "", "", "", ""],
  ["MD 30 OPP HAL PUBLIC SCHOOL", "", "", "", "Cust. Reln. No.", "552309493", "", "", ""],
  ["OLD HAL TOWNSHIP BANGALORE", "", "", "", "Account No.", "5246451104", "", "", ""],
  ["BANGALORE NORTH", "", "", "", "Period", "From 01/04/2026 To 30/06/2026", "", "", ""],
  ["BENGALURU", "", "", "", "Currency", "INR", "", "", ""],
  ["KARNATAKA", "", "", "", "Branch", "BANGALORE-OLD AIRPORT ROAD", "", "", ""],
  ["INDIA", "", "", "", "Nomination Regd", "Y", "", "", ""],
  ["560017", "", "", "", "Nominee Name", "", "", "", ""],
  ["", "", "", "", "Joint Holder(s)", "", "", "", ""],
  ["", "", "", "", "IFSC", "KKBK0008109", "", "", ""],
  ["", "", "", "", "MICR", "560485065", "", "", ""],
  ["", "", "", "", "", "", "", "", ""],
  ["Sl. No.", "Transaction Date", "Value Date", "Description", "Chq /Ref No.", "Amount", "Dr / Cr", "Balance", "Dr / Cr"],
  ["1", "01-04-2026 18:04:51", "01-04-2026", "UPI/ADITYA  MISHRA/609184582646/UPI", "UPI-609125335724", "501.00", "CR", "10,179.12", "CR"],
  ["2", "20-04-2026 13:01:21", "20-04-2026", "UPI/KIRAN/121885447206/UPI", "UPI-611032490126", "952.00", "DR", "9,227.12", "CR"],
  ["3", "25-04-2026 05:34:43", "25-04-2026", "UPI/TAMIL ARASI S/122114833136/UPI", "UPI-611559023935", "713.00", "DR", "8,514.12", "CR"],
  ["Closing Balance", "as on 30/06/2026 INR 8,514.12", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", ""],
  ["Important Note:", "", "", "", "", "", "", "", ""],
  ["The transaction date refers to the date & time when the transactions have been posted in the system.", "", "", "", "", "", "", "", ""],
];

// HDFC XLS: 20 preamble rows, an asterisk rule under the header, a summary
// block of label/value row pairs, and an end-of-statement marker.
const HDFC = [
  ["HDFC BANK Ltd.                    Page No .:   1                    Statement of accounts", "", "", "", "", "", ""],
  ["", "", "", "", "", "", ""],
  ["MR      ABHAY ANAND VATSA", "", "", "", "Address :LOWER GROUND FLOOR,PRITECH PARK", "", ""],
  ["MD 30 OLD HAL TOWNSHIP VIMANAPURA", "", "", "", "FOOD COURT,INSIDE RMZ ECOSPACE,", "", ""],
  ["BENGALURU 560017", "", "", "", "City :BENGALURU 560103", "", ""],
  ["KARNATAKA INDIA", "", "", "", "State :KARNATAKA", "", ""],
  ["JOINT HOLDERS :", "", "", "", "OD Limit :0.00   Currency :INR", "", ""],
  ["", "", "", "", "Cust ID :268335288", "", ""],
  ["Nomination  :  Not Registered", "", "", "", "Account No :50100690137022   OTHER", "", ""],
  ["Statement From  :  01/01/2026         To  :  30/06/2026", "", "", "", "A/C Open Date :30/01/2024", "", ""],
  ["", "", "", "", "RTGS/NEFT IFSC :HDFC0009329   MICR :560240170", "", ""],
  ["*******************************************************************************", "", "", "", "", "", ""],
  ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["********", "**********************************", "************", "********", "******************", "******************", "******************"],
  ["02/01/26", "464746153-EMI RTN CHARGES-DECEMBE 121225-MIR2600184260606", "MIR2600184260606", "02/01/26", "236", "", "16882.51"],
  ["05/01/26", "UPI-ABHAY ANAND VATSA-UBHAYVATSAANAND-3@OKHDFCBANK-KKBK0008109-116709260873-UPI", "0000116709260873", "05/01/26", "", "21315.8", "38198.31"],
  ["06/01/26", "UPI-DEEPAK-PAYTMQR6VWL5S@PTYS-YESB0PTMUPI-116787107524-UPI", "0000116787107524", "06/01/26", "120", "", "38078.31"],
  ["", "", "", "", "", "", ""],
  ["********", "**********************************", "************", "********", "******************", "******************", "******************"],
  ["STATEMENT SUMMARY  :-", "", "", "", "", "", ""],
  ["Opening Balance", "", "", "", "Debits", "Credits", "Closing Bal"],
  ["17118.51", "", "", "", "356", "21315.8", "38078.31"],
  ["", "", "", "", "Dr Count", "Cr Count", ""],
  ["", "", "", "", "2", "1", ""],
  ["---  End Of Statement ---", "", "", "", "", "", ""],
];

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------
{
  assert.equal(parseAmount("1,42,772.12"), 142772.12, "Indian digit grouping");
  assert.equal(parseAmount("(120)"), -120, "accounting negative");
  assert.equal(parseAmount("Rs 1,234"), 1234);
  assert.equal(parseAmount("500 DR"), -500, "trailing Dr marker");
  assert.equal(parseAmount(""), null, "blank is null, never 0");
  assert.equal(parseAmount("   "), null);
  assert.equal(parseAmount("-"), null, "a dash is not an amount of zero");
  assert.equal(parseAmount("N/A"), null);
  assert.equal(parseAmount(0), 0, "a real zero survives");
}

// ---------------------------------------------------------------------------
// Dates - the highest-consequence parsing decision in the file
// ---------------------------------------------------------------------------
{
  // The exact bug that shipped: SheetJS read Kotak's 1 April as 4 January.
  assert.equal(parseStatementDate("01-04-2026", { dayFirst: true }).iso, "2026-04-01");
  assert.equal(parseStatementDate("01-04-2026", { dayFirst: false }).iso, "2026-01-04");

  // One unambiguous date settles the convention for the whole file.
  assert.equal(detectDayFirst(["01-04-2026", "20-04-2026"]).dayFirst, true);
  assert.equal(detectDayFirst(["01-04-2026", "20-04-2026"]).confidence, "proven");
  assert.equal(detectDayFirst(["04-20-2026"]).dayFirst, false);
  assert.equal(detectDayFirst(["20-04-2026", "04-20-2026"]).confidence, "conflict",
    "a file using both conventions is reported, not silently resolved");
  assert.equal(detectDayFirst(["01-02-2026"]).confidence, "assumed");

  assert.equal(parseStatementDate("20-04-2026 13:01:21", { dayFirst: true }).iso, "2026-04-20");
  assert.equal(parseStatementDate("20-04-2026 13:01:21", { dayFirst: true }).time, "13:01:21");
  assert.equal(parseStatementDate("2026-04-20").iso, "2026-04-20", "ISO ignores the dayFirst hint");
  assert.equal(parseStatementDate("16/01/26", { dayFirst: true }).iso, "2026-01-16", "two-digit year is recent");
  assert.equal(parseStatementDate("31-02-2026", { dayFirst: true }), null, "no such date");
  assert.equal(parseStatementDate("as on 30/06/2026 INR 3,825.80"), null,
    "a whole cell must be a date - this footer sits in the date column");
  assert.equal(parseStatementDate("Closing Balance"), null);
}

// ---------------------------------------------------------------------------
// Column binding
// ---------------------------------------------------------------------------
{
  assert.equal(roleOfHeader("Dr / Cr"), "sign");
  assert.equal(roleOfHeader("Withdrawal Amt."), "debit");
  assert.equal(roleOfHeader("Value Dt"), "valueDate");
  assert.equal(roleOfHeader("Transaction Date"), "date");
  assert.equal(roleOfHeader("Chq./Ref.No."), "reference");
  assert.equal(roleOfHeader("Closing Balance"), "balance");

  // The duplicate-header case. A name-keyed mapping loses one of these two and
  // with it the sign of every transaction in the file.
  const kotak = bindColumns(KOTAK[13]);
  assert.equal(kotak.amount, 5);
  assert.equal(kotak.amountSign, 6, "the first Dr/Cr binds to Amount");
  assert.equal(kotak.balance, 7);
  assert.equal(kotak.balanceSign, 8, "the second Dr/Cr binds to Balance");
  assert.equal(kotak.date, 1);
  assert.equal(kotak.valueDate, 2);

  const hdfc = bindColumns(HDFC[12]);
  assert.equal(hdfc.debit, 4);
  assert.equal(hdfc.credit, 5);
  assert.equal(hdfc.balance, 6);
  assert.equal(hdfc.amountSign, undefined, "separate debit/credit columns need no sign column");

  assert.equal(bankFromIfsc("KKBK0008109"), "Kotak Mahindra Bank");
  assert.equal(bankFromIfsc("HDFC0009329"), "HDFC Bank");
  assert.equal(bankFromIfsc(null), null);
}

// ---------------------------------------------------------------------------
// Locating the table inside the letter
// ---------------------------------------------------------------------------
{
  const k = shapeStatement(KOTAK, { filename: "kotak.csv" });
  assert.ok(k.ok, "Kotak statement is readable");
  assert.equal(k.headerIndex, 13, "found the header under 13 rows of letterhead");
  assert.equal(k.rows.length, 3, "3 transactions, and none of the 4 footer rows");
  assert.equal(k.meta.bank, "Kotak Mahindra Bank");
  assert.equal(k.meta.accountNumber, "5246451104");
  assert.equal(k.meta.ifsc, "KKBK0008109");
  assert.equal(k.meta.customerId, "552309493");
  assert.equal(k.meta.accountHolder, "ABHAY ANAND VATSA");
  assert.equal(k.meta.periodFrom, "2026-04-01");
  assert.equal(k.meta.periodTo, "2026-06-30");
  assert.equal(k.meta.declared.closing, 8514.12);

  // The Dr/Cr flag actually applied: without it every row here is a credit.
  assert.equal(k.rows[0].credit, 501);
  assert.equal(k.rows[0].debit, null);
  assert.equal(k.rows[1].debit, 952);
  assert.equal(k.rows[1].credit, null);
  assert.equal(k.rows[0].date, "2026-04-01", "1 April, not 4 January");
  assert.equal(k.rows[0].txnTime, "18:04:51");

  const h = shapeStatement(HDFC, { filename: "hdfc.xls" });
  assert.ok(h.ok);
  assert.equal(h.headerIndex, 12);
  assert.equal(h.rows.length, 3, "asterisk rule, summary block and end marker all excluded");
  assert.equal(h.meta.bank, "HDFC Bank");
  assert.equal(h.meta.accountNumber, "50100690137022", "account number packed into one cell with other text");
  assert.equal(h.meta.ifsc, "HDFC0009329");
  assert.equal(h.meta.periodFrom, "2026-01-01");
  assert.equal(h.meta.declared.opening, 17118.51, "read from the label/value row pair");
  assert.equal(h.meta.declared.debitCount, 2);
  assert.equal(h.rows[0].debit, 236);
  assert.equal(h.rows[1].credit, 21315.8);

  // The regression that started all of this.
  assert.ok(!Object.values(h.mapping).includes("__EMPTY"), "no placeholder column names");
  assert.equal(shapeStatement([], { filename: "x.csv" }).reason, "empty_sheet");
  assert.equal(shapeStatement([["hello"], ["world"]], { filename: "x.csv" }).reason, "no_transaction_table");
  assert.ok(!shapeStatement([["hello"]], { filename: "notes.csv" }).ok);
}

// ---------------------------------------------------------------------------
// The audit - the parse proving itself
// ---------------------------------------------------------------------------
{
  const h = shapeStatement(HDFC, { filename: "hdfc.xls" });
  const audit = auditStatement(h);
  assert.equal(audit.confidence, "proven");
  assert.ok(audit.ok);
  assert.equal(audit.chain.openingImplied, 17118.51, "opening derived from row 1 matches the printed one");
  assert.deepEqual(audit.failures, []);

  // A flipped sign keeps the amount and the date and breaks only the balance.
  const flipped = { ...h, rows: h.rows.map((r, i) => (i === 2 ? { ...r, debit: null, credit: r.debit } : r)) };
  const broken = auditStatement(flipped);
  assert.equal(broken.confidence, "suspect");
  assert.ok(broken.chain.breaks.length >= 1);
  assert.equal(broken.chain.breaks[0].likelyCause, "sign_flipped", "and it says which failure it was");

  // A dropped row also breaks the chain, which is how "112 of 114 rows, looks
  // healthy" is caught.
  const missing = { ...h, rows: [h.rows[0], h.rows[2]] };
  assert.equal(auditStatement(missing).chain.ok, false);

  // No balance column: nothing to check against, and that is said plainly
  // rather than reported as a pass.
  const noBalance = verifyBalanceChain(h.rows.map((r) => ({ ...r, balance: null })));
  assert.equal(noBalance.applicable, false);

  const noDeclared = reconcileDeclared(h.rows, {});
  assert.equal(noDeclared.applicable, false, "absent totals are not passing totals");

  const outside = verifyPeriod(
    [{ date: "2025-01-01", description: "x" }],
    { periodFrom: "2026-01-01", periodTo: "2026-06-30" },
  );
  assert.equal(outside.ok, false, "a mm/dd misread lands outside the printed period");
}

// ---------------------------------------------------------------------------
// Narration grammar
// ---------------------------------------------------------------------------
{
  const hdfcUpi = parseNarration("UPI-ZEPTO MARKETPLACE PR-ZPTMKTP1@KOTAKPAY-KKBK0JPUPIA-125263165198-UPI");
  assert.equal(hdfcUpi.rail, "upi");
  assert.equal(hdfcUpi.counterparty, "ZEPTO MARKETPLACE PR");
  assert.equal(hdfcUpi.vpa, "ZPTMKTP1@KOTAKPAY");
  assert.equal(hdfcUpi.ifsc, "KKBK0JPUPIA");
  assert.equal(hdfcUpi.ref, "125263165198");

  // A VPA containing a hyphen must rejoin without eating the payee's name.
  const own = parseNarration("UPI-ABHAY ANAND VATSA-UBHAYVATSAANAND-3@OKHDFCBANK-KKBK0008109-116709260873-UPI");
  assert.equal(own.counterparty, "ABHAY ANAND VATSA");
  assert.equal(own.vpa, "UBHAYVATSAANAND-3@OKHDFCBANK");

  // ...but a ten-digit phone VPA must NOT be glued to the name.
  const phone = parseNarration("UPI-CHANDAN  KUMAR-9142072413@YBL-UJVN0003373-117634727341-UPI");
  assert.equal(phone.counterparty, "CHANDAN KUMAR");
  assert.equal(phone.vpa, "9142072413@YBL");

  const note = parseNarration("UPI-SHRESTHA  SAXENA-9598180521@IBL-SBIN0008069-617146137211-MOVIE TICKET");
  assert.equal(note.note, "MOVIE TICKET", "the payer's own note is the best category signal in the row");

  const kotakUpi = parseNarration("UPI/Mutual Funds IC/122566745060/Paid Via Elemen(Value Date: 04-05-2026)");
  assert.equal(kotakUpi.counterparty, "Mutual Funds IC");
  assert.equal(kotakUpi.note, "Paid Via Elemen");

  const neft = parseNarration("NEFT CR-KKBK0000958-FIRSTPRINCIPLE APPSFORBHARAT PVT-ABHAY ANAND VATSA-CMS0082668974005");
  assert.equal(neft.rail, "neft");
  assert.equal(neft.counterparty, "FIRSTPRINCIPLE APPSFORBHARAT PVT");

  const inward = parseNarration("NEFT NRE REM AMAZON ASIA PACIFIC HLDGS PTE LTD BO");
  assert.equal(inward.counterparty, "AMAZON ASIA PACIFIC HLDGS PTE LTD BO",
    "a truncated trailing reference stays with the name rather than losing the payer");

  const bill = parseNarration("IB BILLPAY DR-HDFC5X-653029XXXXXX9097");
  assert.equal(bill.rail, "billpay");
  assert.equal(bill.cardLast4, "9097");

  assert.equal(parseNarration("EMI 464746153 CHQ S4647461530141 0226464746153").loanAccount, "464746153");
  assert.equal(parseNarration("UPIRET-20260510-613081537146").reversesRef, "613081537146");
  assert.equal(parseNarration("50200091744612-TPT-STIPEND-PRIYAYUSH JARURAT CARE FOUNDATION").note, "STIPEND");
  assert.equal(parseNarration("").rail, "other");
}

// ---------------------------------------------------------------------------
// Merchant vs person, read off the rails rather than the name
// ---------------------------------------------------------------------------
{
  const shop = parseNarration("UPI-DEEPAK-PAYTMQR6VWL5S@PTYS-YESB0PTMUPI-116787107524-UPI");
  assert.equal(counterpartyKind(shop).kind, "merchant", "a PaytmQR VPA is a registered merchant");

  const friend = parseNarration("UPI-SANJEEV KUMAR-GORALAL951@OKICICI-UCBA0000239-117616627209-UPI");
  assert.equal(counterpartyKind(friend).kind, "person", "an @ok<bank> handle is a private individual");

  const merchantIfsc = parseNarration("UPI-VFM MOTORS-VFMMOTORS.42507933@HDFCBANK-HDFC0MERUPI-124515533719-UPI");
  assert.equal(counterpartyKind(merchantIfsc).kind, "merchant");

  // Consumer payment apps are people, not shops.
  const superMoney = parseNarration("UPI-MS TUBA-9971307608@SUPERYES-IDIB000J029-615144737639-UPI");
  assert.equal(counterpartyKind(superMoney).kind, "person");
}

// ---------------------------------------------------------------------------
// Flow types - the difference between money moving and money being spent
// ---------------------------------------------------------------------------
{
  const owner = buildOwnerIdentity([
    { accountHolder: "ABHAY ANAND VATSA", ifsc: "KKBK0008109", accountNumber: "5246451104", vpas: [] },
    { accountHolder: "ABHAY ANAND VATSA", ifsc: "HDFC0009329", accountNumber: "50100690137022", vpas: [] },
  ]);
  const classify = (description, { debit = null, credit = null } = {}) =>
    classifyTransaction({ description, debit, credit, date: "2026-05-04" }, { owner });

  // Own money, recognised three different ways.
  assert.equal(classify("UPI-ABHAY ANAND VATSA-UBHAYVATSAANAND-2@OKICICI-KKBK0008109-122566537281-UPI",
    { debit: 87658.57 }).flow, "self_transfer_out");
  assert.equal(classify("UPI/ABHAY ANAND VAT/122566537281/UPI", { credit: 87658.57 }).flow, "self_transfer_in",
    "Kotak truncates the payee to 15 characters and it still matches");
  assert.equal(classify("UPI/UBHAY  ANAND VA/123871275393/UPI", { debit: 44211 }).flow, "self_transfer_out",
    "the same person is ABHAY at one bank and UBHAY at another");

  // Outflow that is not spending.
  assert.equal(classify("IB BILLPAY DR-HDFC5X-653029XXXXXX9097", { debit: 9809.73 }).flow, "card_payment");
  assert.equal(classify("UPI-GROWW INVEST TECH PV-GROWW.BRK@VALIDHDFC-HDFC0MERUPI-124400182606-PAID VIA ELEMENTS",
    { debit: 20000 }).flow, "investment");
  assert.equal(classify("NACH-MUT-DR-INDIAN CLEARING CORP-0000QQYN247A6IBI", { debit: 25000 }).flow, "investment");
  assert.equal(classify("PG LOAN FORECLOSURE HDFC HDFC BANK LTD", { debit: 205775 }).flow, "loan_principal");
  assert.equal(classify("EMI 464746153 CHQ S4647461530141 0226464746153", { debit: 29057 }).flow, "loan_emi");
  assert.equal(classify("NEFT HDFCH00980436241 NSE CLEARING LIMITED MFSS S", { credit: 184840.25 }).flow,
    "investment_return");

  for (const flow of ["self_transfer_out", "card_payment", "investment", "loan_principal"]) {
    assert.equal(isSpending(flow), false, `${flow} must never count as spending`);
  }
  assert.equal(isSpending("spend"), true);
  assert.equal(isSpending("loan_emi"), true, "an EMI genuinely leaves your pocket");

  // Charges and interest.
  assert.equal(classify("CHRG: ECS MANDATE- 81559255 04-MAY-2026", { debit: 59 }).flow, "bank_charge");
  assert.equal(classify("Int.Pd:5246451104:01-04-2026 to 30-06-2026", { credit: 912 }).flow, "interest");
  assert.equal(classify("INTEREST PAID TILL 30-JUN-2026", { credit: 449 }).flow, "interest");

  // People vs shops.
  assert.equal(classify("UPI-DEEPAK-PAYTMQR6VWL5S@PTYS-YESB0PTMUPI-116787107524-UPI", { debit: 120 }).flow, "spend");
  assert.equal(classify("UPI-SANJEEV KUMAR-GORALAL951@OKICICI-UCBA0000239-117616627209-UPI", { debit: 20 }).flow,
    "p2p_out");

  // A marketplace payout is income, NOT a refund. Guessing "refund" from the
  // merchant name read Rs 5.3 lakh of seller payouts as returned money.
  const payout = classify("NEFT CR-ICIC0099999-MEESHO GROCERY PRIVATE LIMITED-ABHAY ANAND VATSA-IN22618037886317",
    { credit: 104420 });
  assert.equal(payout.flow, "income");
  assert.ok(payout.confidence >= 0.8, "a named company on a business rail should not need review");

  // A category is never invented for a bare personal name.
  const stranger = classify("UPI/KIRAN/121885447206/UPI", { debit: 952 });
  assert.equal(stranger.flow, "p2p_out");
  assert.ok(stranger.confidence < 0.72, "an unknowable payment is flagged for review, not guessed");

  // The Razorpay-via-Airtel handle must not read as a telecom bill.
  const ads = classify("UPI-RELEASEMYAD MEDIA PR-RELEASEMYADMEDI190162.RZP@RXAIRTEL-AIRP0000011-124516872984-RELEASEMYADMEDIAPR",
    { debit: 1785 });
  assert.notEqual(ads.category, "Phone and internet", "the PSP handle is not the merchant");

  for (const flow of Object.keys(FLOW_TYPES)) {
    assert.ok(["expense", "income", "transfer"].includes(FLOW_TYPES[flow].direction), `${flow} has a valid direction`);
  }
}

// ---------------------------------------------------------------------------
// Links between rows
// ---------------------------------------------------------------------------
{
  const txns = [
    { id: "a", accountId: "hdfc", date: "2026-05-04", debit: 87658.57, flow: "self_transfer_out", counterparty: "Own account" },
    { id: "b", accountId: "kotak", date: "2026-05-04", credit: 87658.57, flow: "self_transfer_in", counterparty: "Own account" },
    { id: "c", accountId: "hdfc", date: "2026-04-28", debit: 25000, flow: "p2p_out", counterparty: "Ayush Srivastava" },
    { id: "d", accountId: "kotak", date: "2026-04-28", credit: 25000, flow: "p2p_in", counterparty: "Aayush Anand" },
  ];
  const pairs = linkSelfTransfers(txns);
  assert.equal(pairs.length, 1, "the two different people are not welded into one transfer");
  assert.equal(pairs[0].debitId, "a");
  assert.equal(pairs[0].autoApply, true);

  // Same amount, same day, but no name on either side: paired only as a
  // suggestion, because demoting a real payment to a transfer hides it.
  const unnamed = linkSelfTransfers([
    { id: "x", accountId: "one", date: "2026-05-04", debit: 500, flow: "p2p_out" },
    { id: "y", accountId: "two", date: "2026-05-04", credit: 500, flow: "p2p_in" },
  ]);
  assert.equal(unnamed.length, 1);
  assert.equal(unnamed[0].autoApply, false);
}

{
  // A refund of a triple-charge: no single debit equals the credit.
  const rows = [
    { id: "1", date: "2026-03-26", debit: 9809.73, counterparty: "Credit card ••9097", flow: "card_payment" },
    { id: "2", date: "2026-03-26", debit: 9809.73, counterparty: "Credit card ••9097", flow: "card_payment" },
    { id: "3", date: "2026-03-26", debit: 9809.73, counterparty: "Credit card ••9097", flow: "card_payment" },
    { id: "4", date: "2026-03-27", credit: 19619.46, counterparty: "Credit card ••9097", flow: "refund" },
  ];
  const refunds = linkRefunds(rows);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].reason, "refund_of_repeated_charge");
  assert.equal(refunds[0].debitIds.length, 2, "two of the three charges came back");

  const dupes = detectDuplicateCharges(rows, refunds);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].count, 3);
  assert.equal(dupes[0].stillOut, 9809.73, "one charge is still unrefunded and that is the actionable part");

  // A SIP is designed to repeat and must not be reported as a duplicate.
  const sips = detectDuplicateCharges([
    { id: "s1", date: "2026-06-08", debit: 25000, counterparty: "Mutual funds", flow: "investment" },
    { id: "s2", date: "2026-06-08", debit: 25000, counterparty: "Mutual funds", flow: "investment" },
  ]);
  assert.equal(sips.length, 0);

  // A reversal that names its original is matched exactly, not by amount.
  const exact = linkRefunds([
    { id: "p", date: "2026-05-10", debit: 1, reference: "0000613081537146", parsed: { ref: "613081537146" } },
    { id: "q", date: "2026-05-12", credit: 1, parsed: { reversesRef: "613081537146" } },
  ]);
  assert.equal(exact[0].reason, "reversal_names_original_reference");

  // Own-account movement is equal and opposite by construction and must not be
  // mistaken for a refund of itself.
  const selfPair = linkRefunds([
    { id: "m", date: "2026-05-04", debit: 500, flow: "self_transfer_out", counterparty: "Own account" },
    { id: "n", date: "2026-05-04", credit: 500, flow: "self_transfer_in", counterparty: "Own account" },
  ]);
  assert.equal(selfPair.length, 0);
}

{
  // Five monthly EMIs and then nothing: the missing sixth is the finding.
  const emis = ["2026-01-07", "2026-02-07", "2026-03-07", "2026-04-07", "2026-05-07"].map((date, i) => ({
    id: `e${i}`, date, debit: 29057, counterparty: "Loan EMI", flow: "loan_emi",
  }));
  const series = detectRecurring(emis, { asOf: "2026-07-28" });
  assert.equal(series.length, 1);
  assert.equal(series[0].cadence, "monthly");
  assert.equal(series[0].occurrences, 5);
  assert.equal(series[0].missed, true, "the payment that did not happen is the point");
  assert.equal(series[0].annualised, 353526.83);

  // Still paying on schedule -> not missed.
  assert.equal(detectRecurring(emis, { asOf: "2026-05-20" })[0].missed, false);
  // Random one-offs have no rhythm.
  assert.equal(detectRecurring([
    { id: "r1", date: "2026-01-01", debit: 100, counterparty: "Shop" },
    { id: "r2", date: "2026-01-03", debit: 100, counterparty: "Shop" },
    { id: "r3", date: "2026-04-19", debit: 100, counterparty: "Shop" },
  ]).length, 0);
}

{
  // Dates arrive as Date objects from the pg driver. String(date).slice(0,10)
  // gives "Sat Jan 04", Date.parse of which is NaN - and `NaN > 4` is FALSE, so
  // the window guard silently admitted everything and matched on amount alone.
  assert.equal(isoDay(new Date("2026-06-27T18:30:00.000Z")), "2026-06-27");
  assert.equal(isoDay("2026-06-27T18:30:00.000Z"), "2026-06-27");
  assert.equal(isoDay("garbage"), null);
  assert.equal(isoDay(null), null);

  const bank = [{ id: "b1", date: "2026-06-27", debit: 120, counterparty: "Cafe Altitude" }];
  const faraway = matchManualEntries(bank, [
    { id: "m1", amount: 120, description: "lunch", occurred_at: new Date("2026-01-04T18:30:00.000Z") },
  ]);
  assert.equal(faraway.length, 0, "same amount six months apart is not the same event");

  const close = matchManualEntries(bank, [
    { id: "m2", amount: 120, description: "lunch", occurred_at: new Date("2026-06-27T09:00:00.000Z") },
  ]);
  assert.equal(close.length, 1);
  assert.ok(close[0].score >= 0.7);
  assert.equal(close[0].keepDescription, "lunch", "the hand-typed note survives; the statement will never know it");
}

// ---------------------------------------------------------------------------
// The whole pipeline, both statements together
// ---------------------------------------------------------------------------
{
  const result = ingestStatements(
    [{ filename: "kotak.csv", aoa: KOTAK }, { filename: "hdfc.xls", aoa: HDFC }],
    { asOf: "2026-07-28" },
  );
  assert.ok(result.ok);
  assert.equal(result.transactions.length, 6);
  assert.equal(result.accounts.length, 2, "both accounts learned from the files themselves");
  assert.ok(result.accounts.every((a) => a.ifsc), "each account carries its IFSC for future self-transfer detection");
  assert.ok(result.statements.every((s) => s.audit.confidence !== "suspect"));

  // Seeing the Kotak statement is what makes the HDFC row paying KKBK0008109
  // a recognised self transfer.
  const own = result.transactions.find((t) => t.description.includes("KKBK0008109"));
  assert.equal(own.flow, "self_transfer_in");
  assert.equal(own.countsAsSpending, false);
  assert.equal(own.countsAsIncome, false);

  assert.ok(result.totals.spending <= result.totals.grossOut, "spending is a subset of outflow");
  assert.equal(
    Math.round((result.totals.grossOut - result.totals.spending) * 100) / 100,
    result.totals.nonSpendingOutflow,
    "the two figures reconcile exactly",
  );
  // The self-transfer credit is real money arriving that is NOT income.
  assert.ok(result.totals.grossIn > result.totals.income, "own-account inflow is excluded from earnings");

  // Re-importing the same files yields the same content keys, which is what
  // makes the second import a no-op instead of a duplicate of the first.
  const again = ingestStatements(
    [{ filename: "kotak.csv", aoa: KOTAK }, { filename: "hdfc.xls", aoa: HDFC }],
    { asOf: "2026-07-28" },
  );
  assert.deepEqual(
    again.transactions.map((t) => t.contentKey),
    result.transactions.map((t) => t.contentKey),
  );
  // ...and the key survives a renamed file, because a re-download is normal.
  const renamed = ingestStatements(
    [{ filename: "kotak (1).csv", aoa: KOTAK }],
    { asOf: "2026-07-28" },
  );
  assert.equal(renamed.transactions[0].contentKey, result.transactions[0].contentKey);

  // Two identical payments on one day are two payments, not one.
  const twice = [...KOTAK.slice(0, 15), KOTAK[14], ...KOTAK.slice(15)];
  const dup = ingestStatements([{ filename: "k.csv", aoa: twice }], { asOf: "2026-07-28" });
  const keys = dup.transactions.map((t) => t.contentKey);
  assert.equal(new Set(keys).size, keys.length, "repeats within one file get distinct keys and both survive");

  assert.equal(accountKeyOf({ accountNumber: "5246451104" }), "acct:5246451104");
  assert.ok(contentKeyOf({ date: "2026-04-01", debit: 100, description: "x" }, "acct:1").includes("acct:1"));
}

// ---------------------------------------------------------------------------
// A statement that cannot be verified must not be written
// ---------------------------------------------------------------------------
{
  const script = readFileSync("scripts/import-statements.mjs", "utf8");
  assert.ok(/confidence === "suspect"/.test(script), "the importer checks the audit verdict");
  assert.ok(/Refusing to import/.test(script), "and refuses rather than writing numbers the bank disagrees with");

  const service = readFileSync("src/services/supabase-data.js", "utf8");
  assert.ok(
    /onConflict:\s*"user_id,content_key"/.test(service),
    "statement_rows upserts on content only - an import_id in the key is minted fresh and can never collide",
  );
  assert.ok(!/onConflict:\s*"user_id,import_id/.test(service), "the import-scoped dedupe key is gone");

  const migration = readdirSync("supabase/migrations").find((f) => /bank_accounts_and_flows/.test(f));
  assert.ok(migration, "the accounts/flows migration exists");
  const sql = readFileSync(`supabase/migrations/${migration}`, "utf8");
  for (const needle of ["bank_accounts", "flow_type", "counts_as_spending", "ledger_links", "recurring_series"]) {
    assert.ok(sql.includes(needle), `migration is missing ${needle}`);
  }
  assert.ok(/enable row level security/.test(sql), "new user-owned tables have RLS");

  // The reader must never let the sheet library interpret dates: that is what
  // read Kotak's 1 April as 4 January.
  const reader = readFileSync("src/imports/sheet-reader.js", "utf8");
  assert.ok(/cellDates:\s*false/.test(reader));
  assert.ok(/raw:\s*true/.test(reader));
}

// ---------------------------------------------------------------------------
// Names one bank truncated and another printed in full
// ---------------------------------------------------------------------------
{
  const rows = (name) => [
    ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
    ["05/03/26", `UPI-${name}-THEOTHERGUYASUS@OKSBI-SBIN0001114-606463289733-UPI`, "125", "", "900"],
  ];
  const merged = ingestStatements([
    { filename: "a.csv", aoa: rows("AYUSH  SRIVASTAVA") },
    { filename: "b.csv", aoa: rows("AYUSH  SRIVASTA") },
  ], { asOf: "2026-07-28" });
  const parties = new Set(merged.transactions.map((t) => t.counterparty));
  assert.equal(parties.size, 1, "Kotak truncates at 15 chars; it is still the same person");
  assert.equal([...parties][0], "Ayush Srivastava", "the fuller spelling wins");

  // A short name must NOT be swallowed by a longer one that starts with it.
  const distinct = ingestStatements([
    { filename: "c.csv", aoa: [
      ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
      ["05/03/26", "UPI-RAVI-8792315394-3@IBL-SBIN0011142-117828942069-UPI", "950", "", "900"],
      ["06/03/26", "UPI-RAVIKUMAR SHETTY-RKS@OKSBI-SBIN0001114-117828942070-UPI", "50", "", "850"],
    ] },
  ], { asOf: "2026-07-28" });
  assert.equal(new Set(distinct.transactions.map((t) => t.counterparty)).size, 2,
    "Ravi and Ravikumar Shetty are two people");
}

console.log("statement pipeline tests passed");
