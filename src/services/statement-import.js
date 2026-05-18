// Browser-side bank statement importer.
// Uses SheetJS (xlsx) via CDN — free and works in-browser.
// Steps: parse → detect columns → preview → user confirm → write statement_imports + statement_rows.

import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { getSupabaseClient } from "./supabase-client.js";
import { getCurrentSession } from "./auth.js";
import { classifyImportColumns } from "../../lib/agent-core.mjs";

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
  return {
    totalRows: rows.length,
    debitTotal: Math.round(debit),
    creditTotal: Math.round(credit),
    datedRows: dated,
  };
}

function numericFrom(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
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

  const inserts = parsed.rows.map((r) => buildStatementRow(r, parsed.mapping, importRow.id, session.user.id));

  const BATCH = 500;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const slice = inserts.slice(i, i + BATCH);
    const { error: rowErr } = await supabase
      .from("statement_rows")
      .upsert(slice, { onConflict: "user_id,import_id,row_hash", ignoreDuplicates: true });
    if (rowErr) throw rowErr;
  }

  await supabase
    .from("statement_imports")
    .update({ status: "imported" })
    .eq("id", importRow.id);

  return { importId: importRow.id, rows: inserts.length };
}

function buildStatementRow(raw, mapping, importId, userId) {
  const description = stringOrNull(raw[mapping.description]);
  const debit = numericFrom(raw[mapping.debit]);
  const credit = numericFrom(raw[mapping.credit]);
  const balance = numericFrom(raw[mapping.balance]);
  const reference = stringOrNull(raw[mapping.reference]);
  const occurredOn = parseDate(raw[mapping.date]);
  const hashSource = `${occurredOn || ""}|${description || ""}|${debit}|${credit}|${reference || ""}`;
  return {
    user_id: userId,
    import_id: importId,
    row_hash: hashCode(hashSource),
    occurred_on: occurredOn,
    description,
    debit: debit || null,
    credit: credit || null,
    balance: balance || null,
    reference,
  };
}

function stringOrNull(v) {
  if (v == null || v === "") return null;
  return String(v).trim().slice(0, 280) || null;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return toIsoDate(v);
  const s = String(v).trim();
  const ddmmyyyy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (ddmmyyyy) {
    const [_, dd, mm, yy] = ddmmyyyy;
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    return toIsoDate(new Date(year, Number(mm) - 1, Number(dd)));
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return toIsoDate(d);
  return null;
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return `h${Math.abs(h).toString(36)}`;
}
