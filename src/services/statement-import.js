// Browser-side bank statement importer.
//
// Steps: read the file raw → find the table → PROVE the parse against the
// bank's own totals → classify each row → link rows to each other → preview →
// user confirms → write bank_accounts + statement_imports + statement_rows +
// ledger_entries + ledger_links.
//
// All the thinking lives in `lib/statement-*.mjs` and `lib/txn-semantics.mjs`,
// which are pure and run identically in Node (`scripts/import-statements.mjs`)
// and in tests. This file is only plumbing: files in, Supabase rows out. That
// split is deliberate - the preview the user approves and the rows that get
// written are produced by the SAME call, so the preview cannot over-promise.
//
// Two earlier failures this replaces:
//  - `sheet_to_json` was handed the raw sheet, so both of the user's real
//    statements produced `__EMPTY` column names and imported ZERO of 187 rows.
//  - `cellDates: true` made SheetJS read Kotak's `01-04-2026` (1 April) as
//    4 January. Cells are now read as raw text and dated by evidence.

import {
  createStatementImport,
  fetchBankAccounts,
  fetchExistingStatementKeys,
  fetchManualLedgerEntries,
  insertLedgerEntriesBatch,
  insertLedgerLinks,
  insertStatementRowsBatch,
  setStatementImportStatus,
  upsertBankAccount,
  upsertRecurringSeries,
} from "./supabase-data.js";
import { readStatementFile } from "../imports/sheet-reader.js";
import { ingestStatements } from "../../lib/statement-ingest.mjs";

/**
 * Read and analyse the dropped files without writing anything.
 *
 * Several files at once is the supported case, not an edge case: a transfer
 * between the user's own accounts can only be recognised when both statements
 * are analysed together, and each file teaches the classifier which accounts
 * belong to the user.
 */
export async function analyseStatementFiles(fileList) {
  const files = [];
  for (const file of Array.from(fileList || [])) {
    files.push(await readStatementFile(file));
  }
  if (!files.length) throw new Error("No files to read");

  // Existing accounts matter even when only one file is dropped: they are how
  // last month's Kotak import makes this month's HDFC statement recognise a
  // payment to KKBK0008109 as the user's own money.
  const knownAccounts = await safely(fetchBankAccounts, []);
  const analysis = ingestStatements(files, {
    knownAccounts,
    asOf: new Date().toISOString().slice(0, 10),
  });
  if (!analysis.ok) {
    throw new Error(analysis.rejected.map((r) => r.message).join(" ") || "No transactions found in that file");
  }

  // Only now, with the date span known, ask for the hand-logged entries the
  // bank rows might duplicate, and for which content keys are already stored.
  const span = spanOf(analysis.transactions);
  const [manualEntries, existingKeys] = await Promise.all([
    span ? safely(() => fetchManualLedgerEntries(span), []) : Promise.resolve([]),
    safely(() => fetchExistingStatementKeys(analysis.transactions.map((t) => t.contentKey)), new Set()),
  ]);

  const rescored = manualEntries.length
    ? ingestStatements(files, { knownAccounts, manualEntries, asOf: new Date().toISOString().slice(0, 10) })
    : analysis;

  for (const t of rescored.transactions) t.alreadyImported = existingKeys.has(t.contentKey);
  const newRows = rescored.transactions.filter((t) => !t.alreadyImported);

  return {
    ...rescored,
    files,
    alreadyImported: rescored.transactions.length - newRows.length,
    newRowCount: newRows.length,
  };
}

/**
 * Write an analysed import.
 *
 * Rows already present are skipped by content key rather than re-inserted, so
 * dropping the same statement twice is a no-op and dropping an overlapping
 * period only adds what is new.
 */
export async function commitAnalysis(analysis) {
  const report = {
    accounts: 0,
    inserted: 0,
    alreadyPresent: analysis.alreadyImported || 0,
    links: 0,
    recurring: 0,
    warnings: [],
  };

  // 1. Accounts first - everything else points at them.
  const accountIds = new Map();
  for (const account of analysis.accounts) {
    try {
      accountIds.set(account.accountKey, await upsertBankAccount(account));
      report.accounts += 1;
    } catch (err) {
      report.warnings.push(`Could not save the ${account.bank || "bank"} account: ${messageOf(err)}`);
    }
  }

  // 2. One statement_imports row per file, carrying the verification verdict so
  //    a statement that could not be proven is never silently trusted later.
  const importIds = new Map();
  for (const statement of analysis.statements) {
    try {
      importIds.set(
        statement.accountKey,
        await createStatementImport({
          account_id: accountIds.get(statement.accountKey) || null,
          source_name: statement.filename,
          detected_bank: statement.meta.bank,
          mapping: statement.meta,
          status: "imported",
          row_count: statement.rowCount,
          period_from: statement.meta.periodFrom,
          period_to: statement.meta.periodTo,
          audit_confidence: statement.audit.confidence,
          audit_summary: statement.audit.summary,
          audit_failures: statement.audit.failures,
          declared_totals: statement.meta.declared || {},
          computed_totals: statement.audit.totals.computed || {},
        }),
      );
    } catch (err) {
      report.warnings.push(`Could not record the import of ${statement.filename}: ${messageOf(err)}`);
    }
  }

  // 3. Entries, then the statement rows that point back at them.
  const pending = analysis.transactions.filter((t) => !t.alreadyImported);
  const entryIds = new Map();
  const BATCH = 100;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    let ids;
    try {
      ids = await insertLedgerEntriesBatch(slice.map((t) => toLedgerEntry(t, accountIds)));
    } catch (err) {
      report.warnings.push(`${slice.length} row(s) could not be saved: ${messageOf(err)}`);
      continue;
    }
    slice.forEach((t, index) => entryIds.set(t.id, ids[index]));
    report.inserted += ids.length;

    try {
      await insertStatementRowsBatch(
        slice.map((t, index) => ({
          import_id: importIds.get(t.accountKey) || null,
          account_id: accountIds.get(t.accountKey) || null,
          row_hash: t.contentKey,
          content_key: t.contentKey,
          occurred_on: t.date,
          txn_time: t.txnTime,
          description: t.description,
          debit: t.debit,
          credit: t.credit,
          balance: t.balance,
          reference: t.reference || null,
          flow_type: t.flow,
          counterparty: t.counterparty,
          ledger_entry_id: ids[index],
          promoted_at: new Date().toISOString(),
        })),
      );
    } catch (err) {
      // The money is in the ledger; only the audit trail failed. Say so, rather
      // than letting the next import think these rows were never seen.
      report.warnings.push(`${slice.length} entries were saved but their statement rows were not: ${messageOf(err)}`);
    }
  }

  // 4. Links between entries, and the recurring series.
  try {
    report.links = await insertLedgerLinks(buildLinks(analysis, entryIds));
  } catch (err) {
    report.warnings.push(`Transfer and refund links could not be saved: ${messageOf(err)}`);
  }
  try {
    report.recurring = await upsertRecurringSeries(analysis.analysis.recurring);
  } catch (err) {
    report.warnings.push(`Recurring payments could not be saved: ${messageOf(err)}`);
  }

  for (const [, importId] of importIds) {
    try {
      await setStatementImportStatus(importId, report.warnings.length ? "promoted_partial" : "promoted");
    } catch {
      /* status only - the data is already written */
    }
  }
  return report;
}

function buildLinks(analysis, entryIds) {
  const links = [];
  const push = (kind, fromId, toId, amount, confidence, reason, state) => {
    const from = entryIds.get(fromId);
    const to = entryIds.get(toId);
    if (!from || !to) return;
    links.push({ kind, from_entry_id: from, to_entry_id: to, amount, confidence, reason, state });
  };
  for (const pair of analysis.analysis.transfers) {
    push("self_transfer", pair.debitId, pair.creditId, pair.amount, pair.confidence, pair.reason,
      pair.autoApply ? "applied" : "suggested");
  }
  for (const refund of analysis.analysis.refunds) {
    for (const debitId of refund.debitIds) {
      push("refund", refund.creditId, debitId, refund.amount, refund.confidence, refund.reason, "applied");
    }
  }
  for (const match of analysis.analysis.manualMatches) {
    const from = entryIds.get(match.bankId);
    if (!from) continue;
    // The manual id is a real ledger id already, not one minted in this pass.
    links.push({
      kind: "manual_match",
      from_entry_id: from,
      to_entry_id: match.manualId,
      amount: match.amount,
      confidence: match.score,
      reason: match.reasons.join(","),
      state: match.autoMerge ? "applied" : "suggested",
    });
  }
  return links;
}

function toLedgerEntry(t, accountIds) {
  return {
    account_id: accountIds.get(t.accountKey) || null,
    amount: t.debit || t.credit,
    direction: t.direction,
    flow_type: t.flow,
    merchant: t.counterparty,
    counterparty: t.counterparty,
    counterparty_vpa: t.parsed?.vpa || null,
    rail: t.parsed?.rail || null,
    description: t.description,
    // A statement carries a calendar date and, sometimes, a clock time. Where
    // the bank gave no time the entry sits at local midnight - never at "now",
    // which would scatter a six-month import across today.
    occurred_at: `${t.date}T${t.txnTime || "00:00:00"}+05:30`,
    source_type: "statement",
    reference: t.reference || null,
    balance_after: t.balance,
    counts_as_spending: t.countsAsSpending,
    counts_as_income: t.countsAsIncome,
    confidence: t.confidence,
    classification_confidence: t.confidence,
    classification_reasons: t.reasons,
  };
}

function spanOf(transactions) {
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  if (!dates.length) return null;
  return { fromDate: dates[0], toDate: dates[dates.length - 1] };
}

// A failure to read optional context must not stop the import. The user's
// statement is still importable without knowing their other accounts; it is
// just less clever, and that is a better outcome than an error.
async function safely(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function messageOf(err) {
  return err?.message || err?.error_description || String(err);
}
