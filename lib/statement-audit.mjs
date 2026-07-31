// Proves a parsed statement is correct, instead of asking to be trusted.
//
// A bank statement carries its own checksum: the running balance. If
// `balance[n] === balance[n-1] + credit[n] - debit[n]` holds for every row, then
// every date order, every amount and every debit/credit sign in the parse is
// arithmetically confirmed by the bank. If it breaks, it breaks at a specific
// row and that row can be named.
//
// This matters because the failure modes of statement parsing are silent. A
// mis-read Dr/Cr flag turns spending into income; a dd/mm vs mm/dd slip moves a
// transaction three months; a missed footer row injects a fake payment. None of
// those announce themselves - but all of them break the balance chain.
//
// Pure and dependency-free.

const TOLERANCE = 0.02; // two paise, for banks that round each row independently

/**
 * Walk the running balance and report every break.
 *
 * @param {object[]} rows - shaped rows: {date, debit, credit, balance, ...}
 * @returns {{applicable: boolean, ok: boolean, checked: number, breaks: object[],
 *   openingImplied: number|null, closingImplied: number|null, coverage: number}}
 */
export function verifyBalanceChain(rows) {
  const withBalance = rows.filter((r) => r.balance != null);
  const coverage = rows.length ? withBalance.length / rows.length : 0;
  if (withBalance.length < 2) {
    return { applicable: false, ok: true, checked: 0, breaks: [], openingImplied: null, closingImplied: null, coverage };
  }

  const breaks = [];
  let checked = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const row = rows[i];
    if (prev.balance == null || row.balance == null) continue;
    const delta = round2(row.balance - prev.balance);
    const movement = round2((row.credit || 0) - (row.debit || 0));
    checked += 1;
    if (Math.abs(delta - movement) <= TOLERANCE) continue;
    breaks.push({
      index: i,
      sheetRow: row.sheetRow ?? null,
      date: row.date,
      description: row.description,
      previousBalance: prev.balance,
      balance: row.balance,
      expectedMovement: delta,
      rowMovement: movement,
      gap: round2(delta - movement),
      // A gap that is exactly ±2× the row amount is the signature of a flipped
      // debit/credit sign, which is the single most damaging parse error.
      likelyCause: diagnose(delta, movement, row),
    });
  }

  const first = rows.find((r) => r.balance != null);
  const last = [...rows].reverse().find((r) => r.balance != null);
  return {
    applicable: true,
    ok: breaks.length === 0,
    checked,
    breaks,
    openingImplied: first ? round2(first.balance - (first.credit || 0) + (first.debit || 0)) : null,
    closingImplied: last ? last.balance : null,
    coverage: round2(coverage),
  };
}

function diagnose(delta, movement, row) {
  const amount = (row.debit || 0) + (row.credit || 0);
  if (amount && Math.abs(Math.abs(delta - movement) - 2 * amount) <= TOLERANCE) return "sign_flipped";
  if (Math.abs(movement) <= TOLERANCE && Math.abs(delta) > TOLERANCE) return "amount_not_read";
  if (Math.abs(delta) <= TOLERANCE && Math.abs(movement) > TOLERANCE) return "row_is_not_a_transaction";
  return "missing_or_extra_row";
}

/**
 * Compare the parse against the totals the bank printed on the statement.
 *
 * These are independent numbers: the bank computed them, we computed ours from
 * the rows we managed to read. Agreement means no row was dropped and no footer
 * row was mistaken for a transaction. This is the check that catches a parser
 * which reads 112 of 114 rows and looks completely healthy.
 */
export function reconcileDeclared(rows, declared = {}) {
  const debitTotal = round2(rows.reduce((a, r) => a + (r.debit || 0), 0));
  const creditTotal = round2(rows.reduce((a, r) => a + (r.credit || 0), 0));
  const debitCount = rows.filter((r) => r.debit).length;
  const creditCount = rows.filter((r) => r.credit).length;

  const checks = [];
  const add = (label, expected, actual, unit = "amount") => {
    if (expected == null) return;
    const tol = unit === "count" ? 0 : TOLERANCE;
    checks.push({
      label,
      expected,
      actual,
      diff: round2(actual - expected),
      ok: Math.abs(actual - expected) <= tol,
      unit,
    });
  };

  add("Total debits", declared.debitTotal, debitTotal);
  add("Total credits", declared.creditTotal, creditTotal);
  add("Debit count", declared.debitCount, debitCount, "count");
  add("Credit count", declared.creditCount, creditCount, "count");

  const chain = verifyBalanceChain(rows);
  if (declared.opening != null && chain.openingImplied != null) {
    add("Opening balance", declared.opening, chain.openingImplied);
  }
  if (declared.closing != null && chain.closingImplied != null) {
    add("Closing balance", declared.closing, chain.closingImplied);
  }

  return {
    // "No declared totals to check against" is not the same as "checks passed",
    // and the caller is told which of the two it got.
    applicable: checks.length > 0,
    ok: checks.every((c) => c.ok),
    checks,
    computed: { debitTotal, creditTotal, debitCount, creditCount },
  };
}

/**
 * Dates must sit inside the period the statement says it covers. This is the
 * guard against a dd/mm vs mm/dd misread that the balance chain cannot see:
 * reading 01-04-2026 as 4 January in an April-June statement leaves the
 * arithmetic perfect and the calendar three months wrong.
 *
 * Slack is one week either side because banks value quarter-end interest a day
 * or two outside the printed window.
 */
export function verifyPeriod(rows, { periodFrom, periodTo, slackDays = 7 } = {}) {
  if (!periodFrom && !periodTo) {
    return { applicable: false, ok: true, outside: [], span: spanOf(rows) };
  }
  const lo = periodFrom ? shiftDays(periodFrom, -slackDays) : null;
  const hi = periodTo ? shiftDays(periodTo, slackDays) : null;
  const outside = rows
    .filter((r) => r.date && ((lo && r.date < lo) || (hi && r.date > hi)))
    .map((r) => ({ sheetRow: r.sheetRow ?? null, date: r.date, description: r.description }));
  return { applicable: true, ok: outside.length === 0, outside, span: spanOf(rows), window: { from: lo, to: hi } };
}

function spanOf(rows) {
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return dates.length ? { from: dates[0], to: dates[dates.length - 1] } : { from: null, to: null };
}

function shiftDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Run every check and return one verdict.
 *
 * `confidence` is deliberately coarse and honest:
 *  - "proven"     every row confirmed by the bank's own arithmetic
 *  - "consistent" internally sound, but the bank printed nothing to check against
 *  - "suspect"    a check failed and the specific rows are listed
 */
export function auditStatement(shaped) {
  const rows = shaped.rows || [];
  const declared = shaped.meta?.declared || {};
  const chain = verifyBalanceChain(rows);
  const totals = reconcileDeclared(rows, declared);
  const period = verifyPeriod(rows, shaped.meta || {});

  const failures = [];
  if (chain.applicable && !chain.ok) failures.push(`balance chain breaks at ${chain.breaks.length} row(s)`);
  if (totals.applicable && !totals.ok) {
    for (const c of totals.checks.filter((x) => !x.ok)) {
      failures.push(`${c.label}: statement says ${c.expected}, rows give ${c.actual}`);
    }
  }
  if (period.applicable && !period.ok) failures.push(`${period.outside.length} row(s) fall outside the statement period`);
  if (shaped.dateFormat?.confidence === "conflict") {
    failures.push("the file mixes dd/mm and mm/dd dates, so some dates cannot be resolved");
  }

  const proven = (chain.applicable && chain.ok) || (totals.applicable && totals.ok);
  const confidence = failures.length ? "suspect" : proven ? "proven" : "consistent";

  return {
    confidence,
    ok: failures.length === 0,
    failures,
    chain,
    totals,
    period,
    dateFormat: shaped.dateFormat || null,
    // One line a person can read, with the number that makes it checkable.
    summary: summarize(confidence, rows.length, chain, totals, failures),
  };
}

function summarize(confidence, rowCount, chain, totals, failures) {
  if (confidence === "suspect") return `${rowCount} rows read, but ${failures[0]}.`;
  const proofs = [];
  if (chain.applicable && chain.ok) proofs.push(`the running balance reconciles across all ${chain.checked} steps`);
  if (totals.applicable && totals.ok) proofs.push(`the totals match the statement's own summary`);
  if (!proofs.length) return `${rowCount} rows read. The statement prints no totals, so nothing independent confirms them.`;
  return `${rowCount} rows read and ${proofs.join(", and ")}.`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
