// Bank statements were stored and then never counted: statement_rows existed,
// were populated, and no row ever became a ledger_entry. These lock the
// promotion rules and the re-import idempotency that closes that hole.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  assignContentKeys,
  countPromotable,
  isoDateOf,
  ledgerDedupeKey,
  merchantFromNarration,
  normalizeStatementRow,
  parseAmountCell,
  planPromotion,
  shapeRowForPromotion,
  statementRowKey,
  toLedgerEntry,
} from "../src/imports/row-normalizer.js";
import { buildStatementPreview } from "../src/imports/statement-preview.js";

const USER = "user-1";

// ---- absent data must never read as a measured value ----
assert.equal(parseAmountCell(""), null, "a blank cell is not an amount of zero");
assert.equal(parseAmountCell(null), null);
assert.equal(parseAmountCell("  "), null);
assert.equal(parseAmountCell("-"), null, "a dash placeholder is not zero");
assert.equal(parseAmountCell("1,240.50"), 1240.5);
assert.equal(parseAmountCell("(120)"), 120, "accounting parentheses are still an amount");
assert.equal(isoDateOf(""), null);
assert.equal(isoDateOf("not a date"), null, "an unparseable date is null, never today");
assert.equal(isoDateOf("11/05/2026"), "2026-05-11", "dd/mm/yyyy is the Indian bank default");
assert.equal(isoDateOf("2026-05-11T00:00:00Z"), "2026-05-11");

assert.equal(
  normalizeStatementRow({ Balance: "" }, { balance: "Balance" }).balance,
  null,
  "a missing balance stays null instead of reporting a Rs 0 balance",
);

// ---- statement_row -> ledger_entry mapping ----
{
  const built = toLedgerEntry(
    { occurred_on: "2026-05-11", description: "UPI-ZOMATO LTD-9827@ybl", debit: "240", credit: null, reference: "UTR9912" },
    { userId: USER },
  );
  assert.ok(built.ok);
  assert.equal(built.entry.amount, 240);
  assert.equal(built.entry.direction, "expense");
  assert.equal(built.entry.merchant, "zomato");
  assert.equal(built.entry.source_type, "statement");
  assert.equal(built.entry.reference, "UTR9912");
  assert.equal(built.entry.user_id, USER);
  assert.equal(isoDateOf(new Date(built.entry.occurred_at)), "2026-05-11", "the entry lands on the day the bank reported");
}

assert.equal(toLedgerEntry({ occurred_on: "2026-05-11", credit: "5000" }, { userId: USER }).entry.direction, "income");
assert.equal(toLedgerEntry({ description: "x", debit: "10" }, { userId: USER }).reason, "no_date");
assert.equal(toLedgerEntry({ occurred_on: "2026-05-11", description: "opening balance" }, { userId: USER }).reason, "no_amount");
assert.equal(toLedgerEntry({ occurred_on: "2026-05-11", debit: "10", credit: "10" }, { userId: USER }).reason, "debit_and_credit");
assert.equal(toLedgerEntry({ occurred_on: "2026-05-11", debit: "10" }, {}).reason, "no_user");
assert.equal(merchantFromNarration(null), null, "no narration means no merchant, not an invented one");

// ---- the dedupe key must not contain the import id ----
{
  const row = { occurred_on: "2026-05-11", description: "Zomato", debit: 240, credit: null, reference: "UTR1" };
  assert.equal(statementRowKey({ ...row, import_id: "imp-a" }), statementRowKey({ ...row, import_id: "imp-b" }),
    "the same transaction keys identically no matter which import carried it");
}

// ---- genuine same-day repeats survive; a re-import does not duplicate ----
{
  const file = [
    { occurred_on: "2026-05-11", description: "Chai", debit: 20, credit: null, reference: null },
    { occurred_on: "2026-05-11", description: "Chai", debit: 20, credit: null, reference: null },
    { occurred_on: "2026-05-12", description: "Salary", debit: null, credit: 50000, reference: "SAL" },
  ];
  const first = assignContentKeys(file);
  assert.equal(new Set(first.map((r) => r.content_key)).size, 3, "two real identical chais keep two rows");
  const second = assignContentKeys(file.map((r) => ({ ...r })));
  assert.deepEqual(second.map((r) => r.content_key), first.map((r) => r.content_key),
    "re-importing the same file produces the same keys, so the upsert is a no-op");
}

// ---- planPromotion buckets every row and never double-counts ----
{
  const rows = [
    { id: "s1", occurred_on: "2026-05-11", description: "Zomato", debit: 240, credit: null, reference: "UTR1" },
    { id: "s2", occurred_on: "2026-05-11", description: "Chai", debit: 20, credit: null, reference: null },
    { id: "s3", occurred_on: "2026-05-11", description: "Chai", debit: 20, credit: null, reference: null },
    { id: "s4", description: "no date here", debit: 99, credit: null, reference: null },
    { id: "s5", occurred_on: "2026-05-11", description: "OPENING BALANCE", debit: null, credit: null, reference: null },
  ];

  const firstRun = planPromotion(rows, [], { userId: USER });
  assert.equal(firstRun.inserts.length, 3);
  assert.equal(firstRun.skipped.length, 0);
  assert.deepEqual(firstRun.blocked.map((b) => [b.statementRowId, b.reason]), [["s4", "no_date"], ["s5", "no_amount"]]);

  // Everything the first run wrote is now in the ledger. A second pass over the
  // same rows (the "user re-submits after a transport error" case that recorded
  // Rs 240 for an Rs 80 purchase on 2026-07-09) must promote nothing.
  const inLedger = firstRun.inserts.map((i, n) => ({ id: `L${n}`, ...i.entry }));
  const secondRun = planPromotion(rows, inLedger, { userId: USER });
  assert.equal(secondRun.inserts.length, 0, "a re-run inserts nothing");
  assert.equal(secondRun.skipped.length, 3, "and reports all three as already present");
  assert.deepEqual(secondRun.skipped.map((s) => s.statementRowId), ["s1", "s2", "s3"]);
  assert.ok(secondRun.skipped.every((s) => s.ledgerEntryId), "each skipped row links to the entry that already holds it");

  // Multiplicity, not presence: one chai already in the ledger leaves the other
  // chai still owed a row.
  const oneChai = planPromotion(rows, [inLedger[1]], { userId: USER });
  assert.equal(oneChai.skipped.length, 1);
  assert.equal(oneChai.inserts.length, 2);
}

// ---- a ledger entry and its statement row agree on identity ----
{
  const built = toLedgerEntry({ occurred_on: "2026-05-11", description: "Zomato", debit: 240, reference: "UTR1" }, { userId: USER });
  const stored = { id: "L1", amount: "240.00", direction: "expense", occurred_at: built.entry.occurred_at, description: "Zomato", reference: "UTR1" };
  assert.equal(ledgerDedupeKey(built.entry), ledgerDedupeKey(stored),
    "a numeric(14,2) round-trip must not look like a different transaction");
}

// ---- the preview promises exactly what the import delivers ----
{
  const rows = [
    { Date: "11/05/2026", Narration: "Zomato", Withdrawal: "240", Deposit: "", Balance: "1000" },
    { Date: "", Narration: "B/F", Withdrawal: "", Deposit: "", Balance: "1000" },
  ];
  const preview = buildStatementPreview({
    filename: "hdfc-may.xlsx",
    headers: ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
    rows,
  });
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.promotableRows, 1, "only one of the two rows can reach the ledger");
  assert.equal(preview.blockedRows, 1);
  assert.equal(preview.blockers.no_date, 1);

  const shaped = rows.map((r) => shapeRowForPromotion(r, preview.mapping));
  assert.deepEqual(countPromotable(shaped), { promotable: 1, blocked: 1, blockers: { no_date: 1 } });
}

// ---- the writer and the migration must agree with the rules above ----
{
  const service = readFileSync("src/services/statement-import.js", "utf8");
  assert.ok(
    /onConflict:\s*"user_id,content_key"/.test(service),
    "statement_rows must upsert on content only — an import_id in the conflict target can never collide",
  );
  assert.ok(!/onConflict:\s*"user_id,import_id/.test(service), "the import_id dedupe key is gone");
  assert.ok(/source_type/.test(readFileSync("src/imports/row-normalizer.js", "utf8")));

  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
  const promotionMigration = migrations.find((f) => /statement_row_promotion/.test(f));
  assert.ok(promotionMigration, "the promotion migration exists");
  const sql = readFileSync(`supabase/migrations/${promotionMigration}`, "utf8");
  for (const needle of ["content_key", "promoted_at", "promotion_error", "ux_statement_rows_user_content"]) {
    assert.ok(sql.includes(needle), `migration is missing ${needle}`);
  }
  assert.ok(
    /drop constraint if exists statement_rows_user_id_import_id_row_hash_key/.test(sql),
    "the old import-scoped unique key must be dropped or identical rows in one file are still silently dropped",
  );
}

console.log("statement promotion tests passed");
