// One pipeline from a raw sheet to reviewed, classified, linked transactions.
//
// Deliberately the single path for every caller - the browser importer, the
// catch-up script, and the tests all run THIS function. The preview a user
// approves and the rows that get written must be produced by the same code, or
// the preview is a promise the import does not keep.
//
// Stages, in order, each refusing to guess what the previous one could not
// establish:
//   shape    - find the table, read the cells                (statement-shape)
//   audit    - prove the parse against the bank's own numbers (statement-audit)
//   classify - decide what each row means                     (txn-semantics)
//   link     - find the facts that need two rows              (statement-link)
//
// Pure and dependency-free: it takes an array-of-arrays and gives back plain
// objects. Reading files and writing to a database are the caller's job.

import { shapeStatement } from "./statement-shape.mjs";
import { auditStatement } from "./statement-audit.mjs";
import { classifyTransaction, buildOwnerIdentity, isSpending, isIncome, FLOW_TYPES } from "./txn-semantics.mjs";
import { analyseTransactions } from "./statement-link.mjs";

/**
 * Stage 1+2: read one file and prove it.
 *
 * @param {Array<Array<*>>} aoa - sheet as array-of-arrays, cells as raw text
 * @returns {{ok: boolean, shaped: object, audit: object|null, message?: string}}
 */
export function readStatement(aoa, { filename = "" } = {}) {
  const shaped = shapeStatement(aoa, { filename });
  if (!shaped.ok) return { ok: false, shaped, audit: null, message: shaped.message };
  return { ok: true, shaped, audit: auditStatement(shaped) };
}

/**
 * Turn one shaped statement into an account descriptor.
 *
 * The identity is the account NUMBER where the bank gave one, falling back to
 * bank+last4. A statement that identifies nothing gets a key derived from the
 * filename, which keeps re-imports of it idempotent without pretending we know
 * whose account it is.
 */
export function accountKeyOf(meta) {
  if (meta?.accountNumber) return `acct:${meta.accountNumber}`;
  if (meta?.ifsc && meta?.accountLast4) return `ifsc:${meta.ifsc}:${meta.accountLast4}`;
  if (meta?.bank && meta?.accountLast4) return `bank:${meta.bank}:${meta.accountLast4}`;
  return `file:${meta?.filename || "unknown"}`;
}

/**
 * A stable content identity for one transaction, with no import id in it, so
 * re-importing the same statement recognises every row instead of duplicating
 * the file. The account is part of the key because two banks can legitimately
 * show the same amount to the same payee on the same day.
 */
export function contentKeyOf(row, accountKey) {
  return [
    accountKey,
    row.date || "nodate",
    row.debit ? `D${row.debit.toFixed(2)}` : "",
    row.credit ? `C${row.credit.toFixed(2)}` : "",
    normalizeKeyText(row.reference) || normalizeKeyText(row.description),
  ].join("|");
}

function normalizeKeyText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 80);
}

// A bank statement can honestly contain the same transaction twice on one day
// (two identical chai payments). Suffixing repeats within a batch keeps both
// while still making a re-import of the file a no-op.
function assignContentKeys(rows, accountKey) {
  const seen = new Map();
  return rows.map((row) => {
    const base = contentKeyOf(row, accountKey);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...row, contentKey: n === 1 ? base : `${base}#${n}` };
  });
}

/**
 * Full pipeline over one or more statements at once.
 *
 * Several files are processed TOGETHER on purpose. A transfer between the
 * user's own accounts is only visible when both statements are in the same
 * pass, and the account each one identifies teaches the classifier about the
 * others: importing Kotak alongside HDFC is what turns "UPI to KKBK0008109"
 * from an unexplained Rs 87,658 payment into a recognised self transfer.
 *
 * @param {Array<{aoa: Array, filename: string}>} files
 * @param {object} options
 * @param {Array} options.knownAccounts - accounts already stored for this user
 * @param {Array} options.manualEntries - existing hand-logged ledger rows
 * @param {string} options.asOf - date used for "is this recurring payment late"
 */
export function ingestStatements(files, { knownAccounts = [], manualEntries = [], employers = [], asOf = null } = {}) {
  const statements = [];
  const rejected = [];

  for (const file of files) {
    const result = readStatement(file.aoa, { filename: file.filename });
    if (!result.ok) {
      rejected.push({ filename: file.filename, reason: result.shaped.reason, message: result.message });
      continue;
    }
    statements.push({
      filename: file.filename,
      shaped: result.shaped,
      audit: result.audit,
      accountKey: accountKeyOf(result.shaped.meta),
    });
  }
  if (!statements.length) {
    return emptyResult(rejected);
  }

  // The accounts the user is now known to own: everything already stored plus
  // everything these files identify.
  const accounts = mergeAccounts(knownAccounts, statements);
  const owner = buildOwnerIdentity(accounts, accounts.map((a) => a.accountHolder).filter(Boolean));

  let seq = 0;
  const transactions = [];
  for (const statement of statements) {
    const keyed = assignContentKeys(statement.shaped.rows, statement.accountKey);
    for (const row of keyed) {
      const classified = classifyTransaction(row, { owner, employers });
      transactions.push({
        id: `r${++seq}`,
        accountKey: statement.accountKey,
        accountId: statement.accountKey, // linker groups by account identity
        bank: statement.shaped.meta.bank,
        sourceFile: statement.filename,
        ...row,
        flow: classified.flow,
        direction: classified.direction,
        category: classified.category,
        counterparty: classified.counterparty,
        parsed: classified.parsed,
        confidence: classified.confidence,
        reasons: classified.reasons,
        countsAsSpending: isSpending(classified.flow),
        countsAsIncome: isIncome(classified.flow),
      });
    }
  }

  canonicaliseCounterparties(transactions);
  const analysis = analyseTransactions(transactions, { manualEntries, asOf });
  applyLinks(transactions, analysis);

  return {
    ok: true,
    statements: statements.map((s) => ({
      filename: s.filename,
      accountKey: s.accountKey,
      meta: s.shaped.meta,
      audit: s.audit,
      rowCount: s.shaped.rows.length,
      skippedSheetRows: s.shaped.skipped,
    })),
    rejected,
    accounts,
    transactions,
    analysis,
    totals: summarize(transactions),
    review: buildReviewQueue(transactions, analysis),
  };
}

/**
 * Collapse names that one bank truncated and another printed in full.
 *
 * Kotak cuts the payee at 15 characters, so the same friend is "Ayush Srivasta"
 * there and "Ayush Srivastava" on HDFC. Left alone they are two counterparties,
 * which splits every per-person total and stops the recurring detector from
 * ever seeing a rhythm.
 *
 * Only a genuine prefix of a long-enough name merges, and always INTO the
 * longer spelling. A prefix rule on short names would happily merge "Ravi" into
 * "Ravikumar Shetty", so ten characters is the floor.
 */
function canonicaliseCounterparties(transactions) {
  const names = [...new Set(transactions.map((t) => t.counterparty).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const canonical = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (key.length < 10) continue;
    for (const longer of names) {
      if (longer === name || longer.length <= name.length) continue;
      if (longer.toLowerCase().startsWith(key)) {
        canonical.set(name, canonical.get(longer) || longer);
        break;
      }
    }
  }
  if (!canonical.size) return;
  for (const t of transactions) {
    const merged = t.counterparty && canonical.get(t.counterparty);
    if (!merged) continue;
    t.counterparty = merged;
    if (!t.reasons.includes("name_untruncated")) t.reasons.push("name_untruncated");
  }
}

/**
 * Apply the cross-row findings back onto the transactions.
 *
 * Only high-confidence, self-evident links change a row. A cross-account pair
 * that merely has matching arithmetic is left alone and sent to review, because
 * demoting a real payment to "transfer" hides it from every spending total and
 * the user would have no reason to go looking for it.
 */
function applyLinks(transactions, analysis) {
  const byId = new Map(transactions.map((t) => [t.id, t]));

  for (const pair of analysis.transfers) {
    if (!pair.autoApply) continue;
    for (const [id, flow] of [[pair.debitId, "self_transfer_out"], [pair.creditId, "self_transfer_in"]]) {
      const t = byId.get(id);
      if (!t) continue;
      t.flow = flow;
      t.direction = "transfer";
      t.countsAsSpending = false;
      t.countsAsIncome = false;
      t.category = "Transfers";
      t.linkedTo = flow === "self_transfer_out" ? pair.creditId : pair.debitId;
      if (!t.reasons.includes(pair.reason)) t.reasons.push(pair.reason);
    }
  }

  for (const refund of analysis.refunds) {
    const credit = byId.get(refund.creditId);
    if (!credit) continue;
    credit.flow = "refund";
    credit.direction = "income";
    // A refund is not income - it is spending that did not happen. Counting it
    // as income makes a refunded purchase inflate BOTH sides of the ledger.
    credit.countsAsIncome = false;
    credit.countsAsSpending = false;
    credit.refundsIds = refund.debitIds;
    credit.category = credit.category || "Refunds";
    if (!credit.reasons.includes(refund.reason)) credit.reasons.push(refund.reason);
    for (const debitId of refund.debitIds) {
      const debit = byId.get(debitId);
      if (debit) debit.refundedBy = refund.creditId;
    }
  }
}

/**
 * Everything a person has to decide, in one list, most consequential first.
 *
 * The ordering is by money at stake, not by confidence: a Rs 70,000 payment the
 * classifier is 66% sure about matters more than a Rs 10 one it is 55% sure
 * about, and a review queue sorted by confidence buries it.
 */
function buildReviewQueue(transactions, analysis) {
  const items = [];

  for (const t of transactions) {
    if (t.confidence >= 0.72) continue;
    items.push({
      kind: "low_confidence",
      id: t.id,
      date: t.date,
      amount: t.debit || t.credit,
      question: `What was this ${t.debit ? "payment to" : "receipt from"} ${t.counterparty || "an unnamed party"}?`,
      current: t.flow,
      counterparty: t.counterparty,
      description: t.description,
      stake: t.debit || t.credit,
    });
  }

  for (const pair of analysis.transfers.filter((p) => !p.autoApply)) {
    items.push({
      kind: "possible_transfer",
      id: pair.debitId,
      pairedWith: pair.creditId,
      date: pair.date,
      amount: pair.amount,
      question: `Rs ${pair.amount} left one account and the same amount arrived in another the same day. Is this one transfer?`,
      stake: pair.amount,
    });
  }

  for (const dupe of analysis.duplicates.filter((d) => d.stillOut > 0)) {
    items.push({
      kind: "duplicate_charge",
      date: dupe.date,
      amount: dupe.stillOut,
      question: `${dupe.counterparty} charged Rs ${dupe.amount} ${dupe.count} times on one day${dupe.refundedCount ? ` and refunded ${dupe.refundedCount}` : ""}. Was that intended?`,
      ids: dupe.ids,
      stake: dupe.stillOut,
    });
  }

  for (const series of analysis.recurring.filter((s) => s.missed && s.direction === "out")) {
    items.push({
      kind: "missed_recurring",
      date: series.expectedNext,
      amount: series.amount,
      question: `${series.counterparty} has been Rs ${series.amount} ${series.cadence} since ${series.firstSeen}, but nothing since ${series.lastSeen}. Has it stopped?`,
      stake: series.amount,
    });
  }

  for (const match of analysis.manualMatches) {
    items.push({
      kind: match.autoMerge ? "merged_with_manual" : "possible_duplicate_of_manual",
      id: match.bankId,
      pairedWith: match.manualId,
      amount: match.amount,
      question: `This bank row looks like something already logged by hand (Rs ${match.amount}). Same thing?`,
      stake: match.amount,
    });
  }

  return items.sort((a, b) => (b.stake || 0) - (a.stake || 0));
}

/**
 * The headline numbers - and specifically the gap between what the bank shows
 * moving and what was actually spent, which is the whole point of flow types.
 */
export function summarize(transactions) {
  const byFlow = {};
  let grossOut = 0, grossIn = 0, spending = 0, income = 0;
  for (const t of transactions) {
    const out = t.debit || 0;
    const inn = t.credit || 0;
    grossOut += out;
    grossIn += inn;
    if (t.countsAsSpending) spending += out;
    if (t.countsAsIncome) income += inn;
    const slot = (byFlow[t.flow] ||= { flow: t.flow, label: FLOW_TYPES[t.flow]?.label || t.flow, count: 0, out: 0, in: 0 });
    slot.count += 1;
    slot.out += out;
    slot.in += inn;
  }
  const byCategory = {};
  for (const t of transactions) {
    if (!t.countsAsSpending || !t.debit) continue;
    const key = t.category || "Uncategorised";
    byCategory[key] = round2((byCategory[key] || 0) + t.debit);
  }
  return {
    transactionCount: transactions.length,
    grossOut: round2(grossOut),
    grossIn: round2(grossIn),
    spending: round2(spending),
    income: round2(income),
    net: round2(income - spending),
    // How much of the bank's "debits" figure was never spending at all. This is
    // the number that makes the flow-type work legible.
    nonSpendingOutflow: round2(grossOut - spending),
    byFlow: Object.values(byFlow)
      .map((f) => ({ ...f, out: round2(f.out), in: round2(f.in) }))
      .sort((a, b) => b.out + b.in - (a.out + a.in)),
    byCategory: Object.entries(byCategory)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

function mergeAccounts(known, statements) {
  const byKey = new Map();
  for (const account of known) {
    byKey.set(account.accountKey || accountKeyOf(account), { ...account });
  }
  for (const statement of statements) {
    const meta = statement.shaped.meta;
    const key = statement.accountKey;
    const existing = byKey.get(key) || {};
    const rows = statement.shaped.rows;
    const last = [...rows].reverse().find((r) => r.balance != null);
    byKey.set(key, {
      ...existing,
      accountKey: key,
      bank: meta.bank || existing.bank || null,
      accountNumber: meta.accountNumber || existing.accountNumber || null,
      accountLast4: meta.accountLast4 || existing.accountLast4 || null,
      ifsc: meta.ifsc || existing.ifsc || null,
      micr: meta.micr || existing.micr || null,
      customerId: meta.customerId || existing.customerId || null,
      accountHolder: meta.accountHolder || existing.accountHolder || null,
      vpas: [...new Set([...(existing.vpas || []), ...collectOwnVpas(rows, meta)])],
      lastBalance: last ? last.balance : existing.lastBalance ?? null,
      lastBalanceOn: last ? last.date : existing.lastBalanceOn ?? null,
      isNew: !existing.id,
      id: existing.id || null,
    });
  }
  return [...byKey.values()];
}

// A UPI narration that names the account holder is naming one of THEIR handles.
// Harvesting those makes the next import recognise the same handle instantly,
// even on a statement that prints no IFSC.
function collectOwnVpas(rows, meta) {
  const holder = normalizeName(meta.accountHolder);
  if (!holder) return [];
  const found = new Set();
  for (const row of rows) {
    const m = /([A-Za-z0-9._-]+@[A-Za-z]{2,})/.exec(row.description || "");
    if (!m) continue;
    const name = normalizeName((row.description || "").split("-")[1] || "");
    if (name && (holder.startsWith(name.slice(0, 10)) || name.startsWith(holder.slice(0, 10)))) {
      found.add(m[1].toLowerCase());
    }
  }
  return [...found];
}

function normalizeName(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
}

function emptyResult(rejected) {
  return {
    ok: false,
    statements: [],
    rejected,
    accounts: [],
    transactions: [],
    analysis: { transfers: [], refunds: [], duplicates: [], recurring: [], manualMatches: [], counts: {} },
    totals: summarize([]),
    review: [],
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
