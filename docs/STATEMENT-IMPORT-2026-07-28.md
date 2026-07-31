# Bank statement import, rebuilt - 2026-07-28

Two real statements were imported: Kotak ••1104 (Apr-Jun 2026) and HDFC ••7022
(Jan-Jun 2026). 187 transactions. This note records what was broken, what was
built, and what the data turned out to say.

## What was broken

Before this, **both files imported zero of their 187 rows.**

`parseStatementFile` handed the raw sheet to `sheet_to_json`, which takes row 1
as the header row. Row 1 of a bank statement is the letterhead. The resulting
column names were:

```
["__EMPTY","__EMPTY_1","Account Statement","__EMPTY_2", ...]     Kotak
["HDFC BANK Ltd.  Page No .: 1  Statement of accounts", ...]     HDFC
```

Nothing matched any column candidate, so the mapping was empty, so every row was
unpromotable. The importer reported success.

Three more defects sat behind that one:

1. **Silent date corruption.** The reader used `cellDates: true`. Given Kotak's
   `01-04-2026` (1 April) SheetJS returns a Date of **4 January** - a
   three-month error, invisible in the preview and permanent in the ledger.
2. **Kotak's sign column was unreadable.** Kotak has one `Amount` column and a
   separate `Dr / Cr` flag, and the header contains `Dr / Cr` **twice** (once
   for the amount, once for the balance). Any name-keyed mapping collapses those
   two into one. Every amount in the file is positive, so without the flag the
   entire statement imports as income.
3. **No concept of what a payment was.** `direction in (expense, income,
   transfer)` cannot distinguish a credit-card bill from a grocery run.

## What was built

Four pure modules in `lib/`, one pipeline, used identically by the browser
importer, `scripts/import-statements.mjs`, and the tests.

| Module | Job |
| --- | --- |
| `statement-shape.mjs` | Find the table under the letterhead. Bind columns positionally. Read the account identity. |
| `statement-audit.mjs` | Prove the parse against the bank's own arithmetic. |
| `txn-semantics.mjs` | Parse narration grammar; decide what each row means. |
| `statement-link.mjs` | The facts that need two rows: transfers, refunds, duplicates, rhythms. |
| `statement-ingest.mjs` | Orchestrates the four, over several files at once. |

### Finding the table

Rows are scored for how header-like they are, and a candidate only wins if real
transaction rows follow it. A row is a transaction when its date column holds a
**whole** date and a money column holds a number. That pair of conditions is
what strips every non-transaction row with no footer blocklist: the `********`
rules, repeated page headers, `Closing Balance | as on 30/06/2026 INR 3,825.80`,
the `STATEMENT SUMMARY :-` block, the GSTIN line, `--- End Of Statement ---`.

Dates are read as raw text and the dd/mm-vs-mm/dd convention is decided **once
per file from evidence in the file**: a single `20-04-2026` proves day-first. If
a file contains both conventions that is reported, not silently resolved.

### Proving the parse

A statement carries its own checksum. If `balance[n] = balance[n-1] + credit -
debit` holds for every row, then every date order, amount and debit/credit sign
is confirmed by the bank. Both files verified **proven**:

```
Kotak ••1104   73 rows, balance reconciles across all 72 steps, closing 3,825.80 matches
HDFC  ••7022  114 rows, balance reconciles across all 113 steps, and all 6 declared totals match:
              debits 8,26,499.71 · credits 9,15,469.33 · Dr 81 · Cr 33 · opening 17,118.51 · closing 1,06,088.13
```

The Node importer **refuses to write** a statement whose verdict is `suspect`.
Numbers the bank disagrees with are worse than no numbers.

### Flow types

Every row gets a flow type before it gets a category, because the headline
number is otherwise wrong by an order of magnitude:

```
Rs 15,54,303.78 left the two accounts over six months.
Rs  3,57,018.57 of that was actually spending.
Rs 11,97,285.21 (77%) was not.
```

| Not spending | Amount |
| --- | --- |
| Invested (Groww, ICICI MF, NACH SIPs) | 5,04,000 |
| Moved between own accounts | 2,26,977 |
| Loan principal (incl. foreclosure) | 2,63,889 |
| Credit-card bills | 2,01,399 |

Self-transfers are caught three ways: the destination IFSC is one of the user's
own accounts, the VPA stem matches, or the payee name matches. Name matching is
prefix- and one-character tolerant, because Kotak truncates to 15 characters and
the same person is `ABHAY ANAND VATSA` at one bank and `UBHAY ANAND VATSA` at
the other.

Merchant-vs-person is read off the **rails**, not the name: a PaytmQR VPA or a
`0MERUPI`/`0MCHUPI` IFSC is a registered merchant; an `@ok<bank>` handle or a
phone-number VPA is a private individual. Name alone cannot tell "UPI/KIRAN"
(a friend) from "UPI-DEEPAK-PAYTMQR..." (the tea stall).

### Links between rows

- **2 self-transfer pairs** - Rs 87,658.57 (HDFC→Kotak, 4 May) and Rs 54,789
  (Kotak→HDFC, 29 May), each counted once instead of twice.
- **5 refunds** matched to the payments they reverse, including one that no
  amount-matching could find: three card payments of Rs 9,809.73 on 26 March and
  one credit of Rs 19,619.46 on 27 March. No single debit equals the refund.
- **3 repeated-charge groups.** The triple-charge above was only refunded twice,
  so **Rs 9,809.73 is still out**.
- **4 recurring series**, and two that stopped.

## What the data says

- **The Rs 29,057 EMI ran monthly from 7 January to 7 May and then stopped.**
  The reason is in the other statement: a Rs 2,05,775 loan foreclosure through
  Kotak on 22 May, plus a Rs 58,114 loan prepayment in March that was refunded
  four days later (`RA REFUND POOL`).
- **Rs 1,83,027 went to people, not shops** - the single largest spending
  category, led by Rs 70,000 to Deendayal Upadhyay on 28 April and Rs 72,066
  across six payments to Ayush Srivastava.
- **Income is Rs 7,08,438**, mostly Meesho seller payouts (Rs 3,54,970 over five
  transfers), FirstPrinciple AppsForBharat, and the Priyayush Jarurat Care
  Foundation stipend. Amazon Associates pays four small remittances every month.
- **Rs 5,04,000 was invested and Rs 5,66,295 came back** from NSE Clearing and
  Indian Clearing Corporation - portfolio churn, not income.
- Actual consumption is small and legible: Rs 9,040 travel, Rs 7,804
  subscriptions, Rs 460 entertainment, Rs 441 eating out, Rs 408 groceries.

## Duplication

- Re-importing the same files inserts nothing: `written: 0 new entries, 187
  already present`. Idempotency is by content key (account + date + amount +
  reference), with no import id in it, so a re-download with a new filename is
  still recognised. Two genuinely identical payments on one day both survive.
- The 15 hand-logged entries were checked against every bank row and **none
  matched** - the manual entries are food notes from July, after the statements
  end. Scoring is by amount tolerance plus a date window plus merchant overlap;
  only a score above 0.85 auto-merges, everything else is shown side by side.

## Still open

- 3 payments to single-word Kotak names (Kiran, Chandrashekhar, Santhosh) cannot
  be classified: Kotak narrations carry no VPA, so a first name is all the bank
  gave. They sit in the review queue rather than being guessed.
- Rs 6,533 of spending is uncategorised - small merchant QRs where the payee
  name is a person's ("Deepak" at a Paytm QR is almost certainly a food stall,
  but the statement does not say so).
- Category rules are regex-based. The AI reasoning pass is not yet wired into
  the import path; it should run only over the low-confidence tail.
