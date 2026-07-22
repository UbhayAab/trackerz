// Browser-side bank statement importer.
// Uses SheetJS (xlsx) via CDN — free and works in-browser.
// Steps: parse → detect columns → preview → user confirm → write statement_imports
// + statement_rows → promote those rows into ledger_entries.
//
// Until the promotion step existed, statement_rows was a write-only table: bank
// data was stored and then excluded from every money total in the app.

import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import { classifyImportColumns } from "../../lib/agent-core.mjs";
import {
  assignContentKeys,
  countPromotable,
  isoDateOf,
  parseAmountCell,
  planPromotion,
  shapeRowForPromotion,
  statementRowKey,
  PROMOTION_BLOCKERS,
} from "../imports/row-normalizer.js";
import {
  countUnpromotedStatementRows,
  fetchStatementLedgerEntries,
  fetchUnpromotedStatementRows,
  insertStatementLedgerEntry,
  markStatementRowPromoted,
  markStatementRowUnpromotable,
  setStatementImportStatus,
} from "./supabase-data.js";

export async function parseStatementFile(file) {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Workbook has no sheets");
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (rows.length === 0) throw new Error("Sheet is empty");
  const headers = Object.keys(rows[0]);
  const mapping = classifyImportColumns(headers);
  return { rows, headers, mapping, fileName: file.name };
}

export function summarizePreview(parsed) {
  const { rows, mapping } = parsed;
  let debit = 0, credit = 0, dated = 0;
  for (const r of rows) {
    const d = numericFrom(r[mapping.debit]);
    const c = numericFrom(r[mapping.credit]);
    const dateVal = r[mapping.date];
    if (d) debit += d;
    if (c) credit += c;
    if (dateVal) dated += 1;
  }
  // Run the real promotion rule over the parsed rows so the preview promises
  // exactly what the import will deliver, rather than a row count that includes
  // rows the ledger can never accept.
  const reach = countPromotable(rows.map((r) => shapeRowForPromotion(r, mapping)));
  return {
    totalRows: rows.length,
    debitTotal: Math.round(debit),
    creditTotal: Math.round(credit),
    datedRows: dated,
    promotableRows: reach.promotable,
    blockedRows: reach.blocked,
    blockers: reach.blockers,
  };
}

function numericFrom(v) {
  return parseAmountCell(v) ?? 0;
}

export async function commitImport(parsed) {
  const session = getCurrentSession();
  if (!session?.user?.id) throw new Error("not_authenticated");
  const supabase = await getSupabaseClient();

  const { data: importRow, error: importErr } = await supabase
    .from("statement_imports")
    .insert({
      user_id: session.user.id,
      source_name: parsed.fileName,
      detected_bank: null,
      mapping: parsed.mapping,
      status: "previewed",
      row_count: parsed.rows.length,
    })
    .select()
    .single();
  if (importErr) throw importErr;

  const inserts = assignContentKeys(
    parsed.rows.map((r) => buildStatementRow(r, parsed.mapping, importRow.id, session.user.id)),
  );

  const BATCH = 500;
  let stored = 0;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const slice = inserts.slice(i, i + BATCH);
    // Conflict target is (user_id, content_key) — content only. The old key
    // included import_id, which is freshly minted on every upload, so it could
    // never collide and every re-import duplicated the whole file.
    const { data, error: rowErr } = await supabase
      .from("statement_rows")
      .upsert(slice, { onConflict: "user_id,content_key", ignoreDuplicates: true })
      .select("id");
    if (rowErr) throw rowErr;
    stored += (data || []).length;
  }

  await setStatementImportStatus(importRow.id, "imported");

  return {
    importId: importRow.id,
    rowsParsed: inserts.length,
    rowsStored: stored,
    rowsAlreadyStored: inserts.length - stored,
  };
}

/**
 * Turn confirmed statement_rows into ledger_entries.
 *
 * Every row lands in exactly one bucket and the caller is told about all three —
 * a partial success must never look like a clean one.
 *
 * @returns {Promise<{considered: number, promoted: number, alreadyPresent: number,
 *   failed: Array<{statementRowId: string, reason: string, detail: string|null}>,
 *   warnings: string[]}>}
 */
export async function promoteStatementRows({ importId = null, limit = 2000 } = {}) {
  const session = getCurrentSession();
  if (!session?.user?.id) throw new Error("not_authenticated");
  const userId = session.user.id;

  const rows = await fetchUnpromotedStatementRows({ importId, limit });
  const report = { considered: rows.length, promoted: 0, alreadyPresent: 0, failed: [], warnings: [] };
  if (!rows.length) return report;

  const dates = rows.map((r) => isoDateOf(r.occurred_on)).filter(Boolean).sort();
  const existing = dates.length
    ? await fetchStatementLedgerEntries({ fromDate: dates[0], toDate: dates[dates.length - 1] })
    : [];

  const plan = planPromotion(rows, existing, { userId });

  for (const item of plan.blocked) {
    report.failed.push({
      statementRowId: item.statementRowId,
      reason: item.reason,
      detail: PROMOTION_BLOCKERS[item.reason] || item.reason,
    });
    try {
      await markStatementRowUnpromotable(item.statementRowId, item.reason);
    } catch (err) {
      report.warnings.push(`Could not record why row ${item.statementRowId} was skipped: ${messageOf(err)}`);
    }
  }

  // Already in the ledger from an earlier import of the same transaction: link
  // the row to that entry so it stops being reconsidered, and count it openly
  // as skipped rather than folding it into the promoted number.
  for (const item of plan.skipped) {
    try {
      await markStatementRowPromoted(item.statementRowId, item.ledgerEntryId);
      report.alreadyPresent += 1;
    } catch (err) {
      report.failed.push({ statementRowId: item.statementRowId, reason: "link_failed", detail: messageOf(err) });
    }
  }

  await inWaves(plan.inserts, 6, async (item) => {
    let entryId = null;
    try {
      const inserted = await insertStatementLedgerEntry(item.entry);
      entryId = inserted.id;
    } catch (err) {
      report.failed.push({ statementRowId: item.statementRowId, reason: "insert_failed", detail: messageOf(err) });
      return;
    }
    report.promoted += 1;
    try {
      await markStatementRowPromoted(item.statementRowId, entryId);
    } catch (err) {
      // The money is in the ledger; only the back-link failed. Say so — the next
      // run re-reads this row, recognises the entry it already has by content,
      // and skips it rather than paying for it twice.
      report.warnings.push(`Ledger entry ${entryId} was written but its statement row could not be marked promoted: ${messageOf(err)}`);
    }
  });

  if (importId) {
    const status = report.failed.length ? "promoted_partial" : "promoted";
    try {
      await setStatementImportStatus(importId, status);
    } catch (err) {
      report.warnings.push(`Could not update import status: ${messageOf(err)}`);
    }
  }

  return report;
}

// Every statement row that never reached the ledger, from any import. The rows
// already sitting in production predate the promoter, so fixing the import path
// alone would leave that history permanently missing from the money totals.
export function promoteAllStatementRows(options = {}) {
  return promoteStatementRows({ ...options, importId: null });
}

// The whole path the Import button runs: store the rows, then promote them.
export async function importAndPromote(parsed) {
  const stored = await commitImport(parsed);
  let promotion;
  try {
    promotion = await promoteStatementRows({ importId: stored.importId });
  } catch (err) {
    // The rows are safely in statement_rows; only the ledger step failed. Name
    // which half succeeded so the user does not re-upload the file to "fix" it.
    const wrapped = new Error(`${stored.rowsStored} row(s) stored but none reached your ledger — ${messageOf(err)}`);
    wrapped.cause = err;
    throw wrapped;
  }
  try {
    promotion.remainingUnpromoted = await countUnpromotedStatementRows();
  } catch (err) {
    promotion.remainingUnpromoted = null;
    promotion.warnings.push(`Could not check for older statement rows still missing from your ledger: ${messageOf(err)}`);
  }
  return { ...stored, promotion };
}

async function inWaves(items, width, fn) {
  for (let i = 0; i < items.length; i += width) {
    await Promise.all(items.slice(i, i + width).map(fn));
  }
}

function messageOf(err) {
  return err?.message || err?.error_description || String(err);
}

function buildStatementRow(raw, mapping, importId, userId) {
  const description = stringOrNull(raw[mapping.description]);
  const debit = numericFrom(raw[mapping.debit]);
  const credit = numericFrom(raw[mapping.credit]);
  const balance = parseAmountCell(raw[mapping.balance]);
  const reference = stringOrNull(raw[mapping.reference]);
  const occurredOn = parseDate(raw[mapping.date]);
  const row = {
    user_id: userId,
    import_id: importId,
    occurred_on: occurredOn,
    description,
    debit: debit || null,
    credit: credit || null,
    balance,
    reference,
  };
  return { ...row, row_hash: statementRowKey(row) };
}

function stringOrNull(v) {
  if (v == null || v === "") return null;
  return String(v).trim().slice(0, 280) || null;
}

function parseDate(v) {
  return isoDateOf(v);
}
