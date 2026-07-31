// Import bank statement files straight into the live database.
//
// The same pipeline the app runs in the browser (lib/statement-ingest.mjs),
// driven from Node so a pile of files can be loaded in one go and the result
// inspected with real SQL. Idempotent: re-running it on the same files
// recognises every row by content and inserts nothing.
//
// Usage:
//   node scripts/import-statements.mjs "C:/path/one.csv" "C:/path/two.xls"
//   node scripts/import-statements.mjs --dry-run <files...>     # nothing written
//   node scripts/import-statements.mjs --force-suspect <files>  # import anyway

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { ingestStatements } from "../lib/statement-ingest.mjs";
import { readWorkbook, isCsvName } from "../src/imports/sheet-reader.js";

loadEnv({ path: ".env.local" });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forceSuspect = args.includes("--force-suspect");
const files = args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("Usage: node scripts/import-statements.mjs [--dry-run] <file> [file...]");
  process.exit(2);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL missing in .env.local");
  process.exit(2);
}

const XLSX = await import("../vendor/xlsx/xlsx@0.18.5/index.mjs");
// The query string is stripped before connecting: a `?sslmode=require` in the
// URL overrides the ssl option below and then fails on Supabase's chain. Same
// treatment as scripts/q.mjs.
const client = new pg.Client({
  connectionString: dbUrl.replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  await main();
} finally {
  await client.end();
}

async function main() {
  const userId = await resolveUser();


  const inputs = files.map((path) => {
    const isCsv = isCsvName(path);
    const data = isCsv ? readFileSync(path, "utf8") : new Uint8Array(readFileSync(path));
    const { sheets } = readWorkbook(XLSX, data, { isCsv });
    const best = [...sheets].sort((a, b) => b.aoa.length - a.aoa.length)[0];
    return { filename: basename(path), aoa: best?.aoa || [] };
  });

  const knownAccounts = await loadAccounts(userId);
  const manualEntries = await loadManualEntries(userId);
  const asOf = new Date().toISOString().slice(0, 10);

  const result = ingestStatements(inputs, { knownAccounts, manualEntries, asOf });
  report(result);

  if (!result.ok) {
    console.error("\nNothing could be read. Stopping.");
    process.exitCode = 1;
    return;
  }

  const suspect = result.statements.filter((s) => s.audit.confidence === "suspect");
  if (suspect.length && !forceSuspect) {
    // A statement whose arithmetic does not reconcile is a statement we have
    // misread. Writing it would put numbers in the ledger that the bank does
    // not agree with, and those are worse than no numbers.
    console.error(`\nRefusing to import: ${suspect.length} statement(s) failed verification.`);
    for (const s of suspect) console.error(`  ${s.filename}: ${s.audit.failures.join("; ")}`);
    console.error("Re-run with --force-suspect to import anyway.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  await client.query("begin");
  try {
    const accountIds = await upsertAccounts(userId, result.accounts);
    const written = await writeTransactions(userId, result, accountIds);
    await writeRecurring(userId, result.analysis.recurring);
    await client.query("commit");
    console.log(`\nwritten: ${written.inserted} new entries, ${written.alreadyPresent} already present, ${written.links} links`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

// The project also holds throwaway users left behind by the e2e tests, so
// "the only user" is not a safe assumption. Picks the one with real data and
// says which, or takes --user <email> when that guess would be wrong.
async function resolveUser() {
  const flagIndex = args.indexOf("--user");
  const wanted = flagIndex >= 0 ? args[flagIndex + 1] : null;
  const { rows } = await client.query(
    `select u.id, u.email,
            (select count(*) from ledger_entries l where l.user_id = u.id)
          + (select count(*) from food_logs f where f.user_id = u.id) as activity
       from auth.users u order by activity desc, u.created_at`,
  );
  if (!rows.length) throw new Error("no users in this project");
  if (wanted) {
    const hit = rows.find((r) => r.email === wanted);
    if (!hit) throw new Error(`no user with email ${wanted}`);
    return hit.id;
  }
  const real = rows.filter((r) => !/@test\.local$/.test(r.email || ""));
  const pick = real[0] || rows[0];
  if (real.length > 1 && Number(real[0].activity) === Number(real[1].activity)) {
    throw new Error(`ambiguous user - pass --user <email> (${real.map((r) => r.email).join(", ")})`);
  }
  console.log(`user ${pick.email} (${pick.activity} existing rows)`);
  return pick.id;
}

async function loadAccounts(userId) {
  const { rows } = await client.query(
    `select id, bank, account_number, account_last4, ifsc, micr, customer_id, account_holder, vpas
       from bank_accounts where user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    accountKey: r.account_number ? `acct:${r.account_number}` : `bank:${r.bank}:${r.account_last4}`,
    bank: r.bank,
    accountNumber: r.account_number,
    accountLast4: r.account_last4,
    ifsc: r.ifsc,
    micr: r.micr,
    customerId: r.customer_id,
    accountHolder: r.account_holder,
    vpas: r.vpas || [],
  }));
}

async function loadManualEntries(userId) {
  // Only hand-logged rows. Bank rows are deduped by content key, not by score.
  const { rows } = await client.query(
    `select id, amount, merchant, description, occurred_at
       from ledger_entries
      where user_id = $1 and (source_type is null or source_type not in ('statement','bank'))`,
    [userId],
  );
  return rows;
}

async function upsertAccounts(userId, accounts) {
  const ids = new Map();
  for (const account of accounts) {
    const { rows } = await client.query(
      `insert into bank_accounts
         (user_id, bank, account_number, account_last4, ifsc, micr, customer_id, account_holder, vpas, last_balance, last_balance_on)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (user_id, account_number) where account_number is not null
       do update set bank = coalesce(excluded.bank, bank_accounts.bank),
                     ifsc = coalesce(excluded.ifsc, bank_accounts.ifsc),
                     account_holder = coalesce(excluded.account_holder, bank_accounts.account_holder),
                     -- array_agg over zero rows is NULL, not '{}', so merging two
                     -- empty VPA lists violated the not-null column on re-import.
                     vpas = coalesce(
                       (select array_agg(distinct v) from unnest(bank_accounts.vpas || excluded.vpas) v),
                       '{}'::text[]),
                     last_balance = excluded.last_balance,
                     last_balance_on = excluded.last_balance_on,
                     updated_at = now()
       returning id`,
      [userId, account.bank, account.accountNumber, account.accountLast4, account.ifsc, account.micr,
       account.customerId, account.accountHolder, account.vpas || [], account.lastBalance, account.lastBalanceOn],
    );
    ids.set(account.accountKey, rows[0].id);
    console.log(`  account ${account.bank} ••${account.accountLast4} -> ${rows[0].id}`);
  }
  return ids;
}

async function writeTransactions(userId, result, accountIds) {
  const importIds = new Map();
  for (const statement of result.statements) {
    const { rows } = await client.query(
      `insert into statement_imports
         (user_id, account_id, source_name, detected_bank, mapping, status, row_count,
          period_from, period_to, audit_confidence, audit_summary, audit_failures,
          declared_totals, computed_totals)
       values ($1,$2,$3,$4,$5,'imported',$6,$7,$8,$9,$10,$11,$12,$13)
       returning id`,
      [userId, accountIds.get(statement.accountKey) || null, statement.filename, statement.meta.bank,
       JSON.stringify(statement.meta), statement.rowCount, statement.meta.periodFrom, statement.meta.periodTo,
       statement.audit.confidence, statement.audit.summary, statement.audit.failures,
       JSON.stringify(statement.meta.declared || {}), JSON.stringify(statement.audit.totals.computed || {})],
    );
    importIds.set(statement.accountKey, rows[0].id);
  }

  let inserted = 0;
  let alreadyPresent = 0;
  const entryIds = new Map();

  for (const t of result.transactions) {
    const accountId = accountIds.get(t.accountKey) || null;
    const amount = t.debit || t.credit;
    // occurred_at is anchored to the statement's own clock time where the bank
    // gave one, and to local midnight where it did not. Inventing "now" for a
    // dated bank row would scatter a six-month import across today.
    const occurredAt = `${t.date}T${t.txnTime || "00:00:00"}+05:30`;

    const { rows: existing } = await client.query(
      `select id from statement_rows where user_id = $1 and content_key = $2`,
      [userId, t.contentKey],
    );
    if (existing.length) {
      alreadyPresent += 1;
      continue;
    }

    const { rows: entry } = await client.query(
      `insert into ledger_entries
         (user_id, account_id, amount, direction, flow_type, merchant, counterparty, counterparty_vpa,
          rail, description, occurred_at, source_type, reference, balance_after,
          counts_as_spending, counts_as_income, confidence, classification_confidence, classification_reasons)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'statement',$12,$13,$14,$15,$16,$17,$18)
       returning id`,
      [userId, accountId, amount, t.direction, t.flow, t.counterparty, t.counterparty, t.parsed?.vpa || null,
       t.parsed?.rail || null, t.description, occurredAt, t.reference || null, t.balance,
       t.countsAsSpending, t.countsAsIncome, t.confidence, t.confidence, t.reasons],
    );
    entryIds.set(t.id, entry[0].id);

    await client.query(
      `insert into statement_rows
         (user_id, import_id, account_id, row_hash, content_key, occurred_on, txn_time, description,
          debit, credit, balance, reference, flow_type, counterparty, ledger_entry_id, promoted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
      [userId, importIds.get(t.accountKey), accountId, t.contentKey, t.contentKey, t.date, t.txnTime,
       t.description, t.debit, t.credit, t.balance, t.reference || null, t.flow, t.counterparty, entry[0].id],
    );
    inserted += 1;
  }

  let links = 0;
  const record = async (kind, fromId, toId, amount, confidence, reason, state) => {
    const from = entryIds.get(fromId);
    const to = entryIds.get(toId);
    if (!from || !to) return;
    await client.query(
      `insert into ledger_links (user_id, kind, from_entry_id, to_entry_id, amount, confidence, reason, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (user_id, kind, from_entry_id, to_entry_id) do nothing`,
      [userId, kind, from, to, amount, confidence, reason, state],
    );
    links += 1;
  };

  for (const pair of result.analysis.transfers) {
    await record("self_transfer", pair.debitId, pair.creditId, pair.amount, pair.confidence, pair.reason,
      pair.autoApply ? "applied" : "suggested");
  }
  for (const refund of result.analysis.refunds) {
    for (const debitId of refund.debitIds) {
      await record("refund", refund.creditId, debitId, refund.amount, refund.confidence, refund.reason, "applied");
    }
  }
  for (const match of result.analysis.manualMatches) {
    const bank = entryIds.get(match.bankId);
    if (!bank) continue;
    await client.query(
      `insert into ledger_links (user_id, kind, from_entry_id, to_entry_id, amount, confidence, reason, state)
       values ($1,'manual_match',$2,$3,$4,$5,$6,$7)
       on conflict (user_id, kind, from_entry_id, to_entry_id) do nothing`,
      [userId, bank, match.manualId, match.amount, match.score, match.reasons.join(","),
       match.autoMerge ? "applied" : "suggested"],
    );
    links += 1;
  }

  return { inserted, alreadyPresent, links };
}

async function writeRecurring(userId, series) {
  for (const s of series) {
    await client.query(
      `insert into recurring_series
         (user_id, series_key, counterparty, direction, cadence, amount, amount_varies,
          occurrences, first_seen, last_seen, expected_next, missed, annualised)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (user_id, series_key) do update set
         counterparty = excluded.counterparty, amount = excluded.amount,
         occurrences = excluded.occurrences, last_seen = excluded.last_seen,
         expected_next = excluded.expected_next, missed = excluded.missed,
         annualised = excluded.annualised, updated_at = now()`,
      [userId, s.key, s.counterparty, s.direction, s.cadence, s.amount, s.amountVaries,
       s.occurrences, s.firstSeen, s.lastSeen, s.expectedNext, s.missed, s.annualised],
    );
  }
}

function report(result) {
  for (const s of result.statements) {
    console.log(`\n${s.filename}`);
    console.log(`  ${s.meta.bank || "unknown bank"} ••${s.meta.accountLast4 || "????"}  ${s.meta.periodFrom} to ${s.meta.periodTo}`);
    console.log(`  verification: ${s.audit.confidence.toUpperCase()} - ${s.audit.summary}`);
    for (const f of s.audit.failures) console.log(`    ! ${f}`);
  }
  for (const r of result.rejected) console.log(`\n${r.filename}: ${r.message}`);
  if (!result.ok) return;

  const t = result.totals;
  console.log(`\n${t.transactionCount} transactions`);
  console.log(`  gross out ${inr(t.grossOut)}  ->  actually spent ${inr(t.spending)}`);
  console.log(`  gross in  ${inr(t.grossIn)}   ->  actually earned ${inr(t.income)}`);
  console.log(`  ${inr(t.nonSpendingOutflow)} of outflow was not spending`);
  console.log("\n  by flow:");
  for (const f of t.byFlow) console.log(`    ${f.label.padEnd(26)} ${String(f.count).padStart(4)}  out ${inr(f.out).padStart(14)}  in ${inr(f.in).padStart(14)}`);
  console.log("\n  spending by category:");
  for (const c of t.byCategory) console.log(`    ${c.category.padEnd(26)} ${inr(c.amount).padStart(14)}`);
  console.log(`\n  links: ${JSON.stringify(result.analysis.counts)}`);
  console.log(`  review queue: ${result.review.length} item(s)`);
  for (const item of result.review.slice(0, 12)) console.log(`    [${item.kind}] ${item.question}`);
}

function inr(n) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}
