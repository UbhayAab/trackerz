// Pure statement-row logic: cell parsing, the stable content key that makes a
// re-import idempotent, and the statement_row -> ledger_entries mapping.
//
// Everything here is deliberately dependency-free (no DOM, no Supabase) so the
// promotion rules are unit-testable and so the preview and the writer cannot
// disagree about which rows are promotable.

import { resolveMerchant } from "../domain/money/merchant-aliases.js";

// Why a row could not become a ledger entry. Codes are persisted on
// statement_rows.promotion_error, so they must stay stable.
export const PROMOTION_BLOCKERS = {
  no_date: "no usable date",
  no_amount: "no debit or credit amount",
  debit_and_credit: "debit and credit on the same row",
  no_user: "no signed-in user",
};

// Blank cell -> null, never 0. A missing amount is not an amount of zero.
export function parseAmountCell(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? round2(Math.abs(value)) : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const negated = /^\(.*\)$/.test(raw); // accounting notation: (120) is a debit
  const n = Number(raw.replace(/[()]/g, "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || raw.replace(/[^0-9]/g, "") === "") return null;
  return round2(Math.abs(negated ? -n : n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function normalizeStatementRow(row, mapping) {
  const debit = parseAmountCell(row[mapping.debit]);
  const credit = parseAmountCell(row[mapping.credit]);
  const signedAmount = mapping.amount ? Number(String(row[mapping.amount] ?? "").replace(/[^0-9.-]/g, "")) : NaN;
  const signed = Number.isFinite(signedAmount) ? signedAmount : 0;
  return {
    date: row[mapping.date] ?? null,
    description: row[mapping.description] ?? "",
    debit: debit ?? (signed < 0 ? Math.abs(signed) : 0),
    credit: credit ?? (signed > 0 ? signed : 0),
    balance: mapping.balance ? parseAmountCell(row[mapping.balance]) : null,
    reference: mapping.reference ? row[mapping.reference] ?? "" : "",
  };
}

export function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Accepts a Date, an ISO/PG date string, or a dd/mm/yyyy statement cell.
// Returns YYYY-MM-DD or null — never "today" as a stand-in for an unknown date.
export function isoDateOf(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : toIsoDate(value);
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    const d = new Date(year, Number(dmy[2]) - 1, Number(dmy[1]));
    return Number.isNaN(d.getTime()) ? null : toIsoDate(d);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toIsoDate(d);
}

// A statement carries a calendar date, not a clock time. Anchoring at local
// midnight keeps the entry on the day it actually happened; using "now" would
// invent a time the bank never reported.
export function startOfLocalDayIso(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

function keyText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 80);
}

function amountToken(value) {
  const n = parseAmountCell(value);
  return n == null ? "" : n.toFixed(2);
}

// Content identity of a statement row: what the bank said happened, with no
// import id in it. Keying on the import id (the old row_hash constraint) meant
// every re-import was guaranteed to miss and insert the whole file again.
export function statementRowKey(row) {
  return [
    isoDateOf(row.occurred_on ?? row.date) || "nodate",
    amountToken(row.debit),
    amountToken(row.credit),
    keyText(row.reference) || keyText(row.description),
  ].join("|");
}

// A bank statement can legitimately contain the same transaction twice on one
// day (two identical chai payments). Ordinal-suffixing repeats inside a batch
// keeps both rows while still making a re-import of the same file a no-op.
export function assignContentKeys(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const base = statementRowKey(row);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...row, content_key: n === 1 ? base : `${base}#${n}` };
  });
}

// Content identity of a ledger entry, used to detect a statement row that is
// already in the ledger. Same shape for a candidate we are about to insert and
// for a row already stored, so the two are directly comparable.
export function ledgerDedupeKey(entry) {
  const date = isoDateOf(entry.occurred_at ? new Date(entry.occurred_at) : null);
  return [
    date || "nodate",
    amountToken(entry.amount),
    entry.direction || "",
    keyText(entry.reference) || keyText(entry.description),
  ].join("|");
}

const RAIL_NOISE = /\b(upi|imps|neft|rtgs|ach|pos|atm|atw|nach|ecs|inft|chq|ref|txn|trf|tfr|dr|cr|by|to|from|qr)\b/gi;

// A wrong merchant is worse than no merchant, so an underivable narration
// returns null rather than a guess the user would have to disprove.
export function merchantFromNarration(text) {
  if (!text) return null;
  const resolved = resolveMerchant(text);
  if (resolved.source === "builtin" || resolved.source === "user") return resolved.canonical;
  const tokens = String(text)
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(RAIL_NOISE, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !/^\d+$/.test(t));
  return tokens.slice(0, 3).join(" ").trim() || null;
}

/**
 * Map one statement_rows row to a ledger_entries insert payload.
 * @returns {{ok: true, entry: object} | {ok: false, reason: keyof PROMOTION_BLOCKERS}}
 */
export function toLedgerEntry(row, { userId } = {}) {
  if (!userId) return { ok: false, reason: "no_user" };
  const occurredOn = isoDateOf(row.occurred_on ?? row.date);
  if (!occurredOn) return { ok: false, reason: "no_date" };
  const debit = parseAmountCell(row.debit);
  const credit = parseAmountCell(row.credit);
  if (debit && credit) return { ok: false, reason: "debit_and_credit" };
  const amount = debit || credit;
  if (!amount) return { ok: false, reason: "no_amount" };
  const description = textOrNull(row.description);
  return {
    ok: true,
    entry: {
      user_id: userId,
      amount,
      direction: debit ? "expense" : "income",
      merchant: merchantFromNarration(description),
      description,
      occurred_at: startOfLocalDayIso(occurredOn),
      source_type: "statement",
      reference: textOrNull(row.reference),
    },
  };
}

/**
 * Decide, for a batch of unpromoted statement rows, which become new ledger
 * entries, which are already in the ledger, and which cannot be promoted at all.
 * Matching is by multiplicity, not presence: two genuinely identical bank
 * transactions both land, while a re-import of one of them is recognised.
 *
 * @returns {{inserts: object[], skipped: object[], blocked: object[]}}
 */
export function planPromotion(rows, existingEntries = [], { userId } = {}) {
  const existingByKey = new Map();
  for (const entry of existingEntries) {
    const key = ledgerDedupeKey(entry);
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(entry.id);
  }
  const inserts = [];
  const skipped = [];
  const blocked = [];
  for (const row of rows) {
    const built = toLedgerEntry(row, { userId });
    if (!built.ok) {
      blocked.push({ statementRowId: row.id, reason: built.reason });
      continue;
    }
    const key = ledgerDedupeKey(built.entry);
    const pool = existingByKey.get(key);
    if (pool && pool.length) {
      skipped.push({ statementRowId: row.id, ledgerEntryId: pool.shift(), key });
      continue;
    }
    inserts.push({ statementRowId: row.id, entry: built.entry, key });
  }
  return { inserts, skipped, blocked };
}

// Raw spreadsheet row + column mapping -> the statement_rows shape the
// promotion rules read. Shared by the preview and the writer so the preview
// cannot promise rows the writer will reject.
export function shapeRowForPromotion(raw, mapping) {
  return {
    occurred_on: isoDateOf(raw[mapping.date]),
    description: textOrNull(raw[mapping.description]),
    debit: parseAmountCell(raw[mapping.debit]),
    credit: parseAmountCell(raw[mapping.credit]),
    reference: mapping.reference ? textOrNull(raw[mapping.reference]) : null,
  };
}

// How many of these rows can actually reach the ledger, so the preview can say
// so before the user presses Import instead of after.
export function countPromotable(rows, { userId = "preview" } = {}) {
  const blockers = {};
  let promotable = 0;
  for (const row of rows) {
    const result = toLedgerEntry(row, { userId });
    if (result.ok) promotable += 1;
    else blockers[result.reason] = (blockers[result.reason] || 0) + 1;
  }
  return { promotable, blocked: rows.length - promotable, blockers };
}

function textOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 280);
  return s || null;
}
