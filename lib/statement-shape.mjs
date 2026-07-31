// Finds the transaction table inside a real bank statement export.
//
// A bank statement is not a spreadsheet of transactions. It is a letter with a
// table buried in it: 13 rows of branch address and IFSC before the header on
// Kotak, 20 on HDFC, then a summary block, a GSTIN and a marketing footer after
// the last transaction. Handing the raw sheet to `sheet_to_json` names the
// columns `__EMPTY`, `__EMPTY_1`, ... and every downstream mapping misses, which
// is exactly why both of the user's real statements imported zero rows.
//
// So this module works positionally on an array-of-arrays and answers four
// questions in order: where does the table start, what is each column, which
// rows are transactions, and what does the letterhead say about the account.
//
// Pure and dependency-free (no DOM, no Supabase, no sheet library) so the same
// code runs in the browser importer, in Node scripts and in tests.

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

// Blank -> null, never 0. A missing amount is not an amount of zero; the
// difference decides whether a row is a transaction at all.
export function parseAmount(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? round2(value) : null;
  let raw = String(value).trim();
  if (!raw) return null;
  // Accounting negatives: (1,234.50)
  const bracketed = /^\((.*)\)$/.test(raw);
  if (bracketed) raw = raw.replace(/^\(|\)$/g, "");
  const trailingSign = /(dr|cr)$/i.exec(raw);
  raw = raw.replace(/(dr|cr)$/i, "").trim();
  // Indian grouping (1,42,772.12) and currency marks are noise, but a cell that
  // is only punctuation must not become 0.
  const stripped = raw.replace(/[₹$,\s]|(?:rs\.?)/gi, "");
  if (!/\d/.test(stripped)) return null;
  if (!/^-?\d*\.?\d+$/.test(stripped)) return null;
  let n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  if (bracketed) n = -n;
  if (trailingSign && /dr/i.test(trailingSign[1])) n = -Math.abs(n);
  return round2(n);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const DATE_RE = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parse a statement date cell. Strict: the WHOLE cell must be a date, so
 * "as on 30/06/2026 INR 3,825.80" (Kotak's closing-balance footer, which sits in
 * the date column) is correctly rejected rather than smuggled in as a
 * transaction.
 *
 * `dayFirst` is not guessed per cell - it is decided once per file by
 * `detectDayFirst`, because "01-04-2026" is 1 April in one bank's export and
 * would be 4 January if read the other way round, and a per-cell guess would
 * silently split one statement across two conventions.
 *
 * @returns {{iso: string, time: string|null, ambiguous: boolean} | null}
 */
export function parseStatementDate(value, { dayFirst = true } = {}) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { iso: isoOf(value.getFullYear(), value.getMonth() + 1, value.getDate()), time: null, ambiguous: false };
  }
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);

  let day, month, year;
  if (m[1].length === 4) {
    // ISO-ish 2026-04-01
    year = a; month = b; day = c;
  } else {
    year = c;
    if (a > 12 && b > 12) return null;
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { day = b; month = a; }
    else if (dayFirst) { day = a; month = b; }
    else { day = b; month = a; }
  }
  year = expandYear(year);
  if (!isRealDate(year, month, day)) return null;
  const time = m[4] != null ? `${pad(m[4])}:${m[5]}:${m[6] ? pad(m[6]) : "00"}` : null;
  return { iso: isoOf(year, month, day), time, ambiguous: m[1].length !== 4 && a <= 12 && b <= 12 };
}

// A two-digit year in a statement is always recent. 26 -> 2026, not 1926.
function expandYear(y) {
  if (y >= 1000) return y;
  return y <= 79 ? 2000 + y : 1900 + y;
}

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function isoOf(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Decide dd/mm vs mm/dd for a whole file from the evidence in the file itself.
 * A single "20-04-2026" proves day-first; a single "04-20-2026" disproves it.
 * Both present means the export is internally inconsistent and we say so rather
 * than picking a winner and being wrong about half the rows.
 */
export function detectDayFirst(cells) {
  let dayFirstHits = 0;
  let monthFirstHits = 0;
  for (const cell of cells) {
    const raw = String(cell ?? "").trim();
    const m = DATE_RE.exec(raw);
    if (!m || m[1].length === 4) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirstHits += 1;
    else if (b > 12 && a <= 12) monthFirstHits += 1;
  }
  if (dayFirstHits && monthFirstHits) {
    return { dayFirst: true, confidence: "conflict", dayFirstHits, monthFirstHits };
  }
  if (dayFirstHits) return { dayFirst: true, confidence: "proven", dayFirstHits, monthFirstHits };
  if (monthFirstHits) return { dayFirst: false, confidence: "proven", dayFirstHits, monthFirstHits };
  // No unambiguous date anywhere. Indian bank exports are day-first, but this is
  // an assumption and it is labelled as one.
  return { dayFirst: true, confidence: "assumed", dayFirstHits, monthFirstHits };
}

// ---------------------------------------------------------------------------
// Column roles
// ---------------------------------------------------------------------------

// Matched most-specific-first: "value date" must win over "date", and
// "closing balance" over "balance", or a header lands in the wrong role.
const ROLE_RULES = [
  { role: "sign", rx: /^(dr\s*\/?\s*cr|cr\s*\/?\s*dr|drcr|debit\s*\/\s*credit|type|txn\s*type|transaction\s*type|indicator)$/ },
  { role: "serial", rx: /^(sl\.?\s*no\.?|s\.?\s*no\.?|sr\.?\s*no\.?|#|serial)$/ },
  { role: "valueDate", rx: /^(value\s*(date|dt)\.?|val\s*dt\.?|posting\s*date)$/ },
  { role: "date", rx: /^(transaction\s*date|txn\s*date|tran\s*date|trans\s*date|date|txn\s*dt\.?|posted\s*date)$/ },
  { role: "description", rx: /^(narration|description|particulars?|remarks?|transaction\s*(details?|description|remarks?)|details?)$/ },
  { role: "reference", rx: /(chq\s*\.?\s*\/?\s*ref\.?\s*no|cheque\s*(no|number)|ref\.?\s*(no|id|#)?$|reference|utr|rrn|transaction\s*id)/ },
  { role: "debit", rx: /(withdrawal|debit|paid\s*out|dr\s*amount|withdrawl)/ },
  { role: "credit", rx: /(deposit|credit|paid\s*in|cr\s*amount)/ },
  { role: "balance", rx: /balance/ },
  { role: "amount", rx: /amount|amt/ },
];

function normalizeHeader(cell) {
  return String(cell ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[₹]/g, " ")
    .replace(/[^a-z0-9./#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function roleOfHeader(cell) {
  const text = normalizeHeader(cell);
  if (!text) return null;
  for (const rule of ROLE_RULES) {
    if (rule.rx.test(text)) return rule.role;
  }
  return null;
}

/**
 * Turn a header row into a positional column mapping.
 *
 * Positional, not by name, because Kotak's header contains "Dr / Cr" TWICE -
 * once for the amount and once for the balance. Any name-keyed mapping collapses
 * those two into one column and loses the sign of every transaction.
 *
 * A sign column binds to the nearest money column to its left, which is how the
 * layout reads: `Amount | Dr / Cr | Balance | Dr / Cr`.
 */
export function bindColumns(headerCells) {
  const roles = headerCells.map(roleOfHeader);
  const map = { headers: headerCells.map((c) => String(c ?? "").trim()) };
  const signs = [];

  roles.forEach((role, index) => {
    if (!role) return;
    if (role === "sign") { signs.push(index); return; }
    // First column to claim a role keeps it: a page-repeat of "Date" later in
    // the row must not steal the binding from the real one.
    if (map[role] == null) map[role] = index;
  });

  for (const signIndex of signs) {
    let target = null;
    for (let i = signIndex - 1; i >= 0; i--) {
      if (i === map.amount) { target = "amountSign"; break; }
      if (i === map.balance) { target = "balanceSign"; break; }
      if (i === map.debit || i === map.credit) { target = "amountSign"; break; }
    }
    if (target && map[target] == null) map[target] = signIndex;
  }
  return map;
}

// A mapping is usable when it can answer "when" and "how much". Description is
// wanted but a statement with an unnamed narration column is still importable.
export function mappingScore(map) {
  const hasDate = map.date != null || map.valueDate != null;
  const hasMoney = map.debit != null || map.credit != null || map.amount != null;
  if (!hasDate || !hasMoney) return 0;
  let score = 2;
  if (map.description != null) score += 1;
  if (map.balance != null) score += 1;
  if (map.reference != null) score += 1;
  if (map.debit != null && map.credit != null) score += 1;
  if (map.amount != null && map.amountSign != null) score += 1;
  return score;
}

// ---------------------------------------------------------------------------
// Locating the table
// ---------------------------------------------------------------------------

/**
 * Find the header row by scoring every row for how header-like it is and then
 * requiring that real transaction rows actually follow it. The follow-through
 * test is what rejects HDFC's `Opening Balance | Debits | Credits | Closing Bal`
 * summary block, which scores well as a header but has one numeric row under it.
 */
export function detectHeaderRow(aoa, { dayFirst = true, maxScan = 80 } = {}) {
  let best = null;
  const limit = Math.min(aoa.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const map = bindColumns(aoa[i] || []);
    const score = mappingScore(map);
    if (!score) continue;
    const followers = countDataRowsAfter(aoa, i, map, dayFirst, 40);
    if (!followers) continue;
    const total = score * 10 + Math.min(followers, 20);
    if (!best || total > best.total) best = { index: i, map, score, followers, total };
  }
  return best;
}

function countDataRowsAfter(aoa, headerIndex, map, dayFirst, window) {
  let hits = 0;
  const end = Math.min(aoa.length, headerIndex + 1 + window);
  for (let i = headerIndex + 1; i < end; i++) {
    if (isTransactionRow(aoa[i], map, { dayFirst })) hits += 1;
  }
  return hits;
}

/**
 * A row is a transaction when its date column holds a whole date AND at least
 * one money column holds a number. Both conditions are required, and that pair
 * is what silently strips every non-transaction row: the `********` rule under
 * HDFC's header, the repeated page header, `Closing Balance | as on 30/06/2026
 * INR 3,825.80`, the `STATEMENT SUMMARY :-` block, the GSTIN line and
 * `--- End Of Statement ---`. No footer blocklist to keep up to date.
 */
export function isTransactionRow(row, map, { dayFirst = true } = {}) {
  if (!Array.isArray(row)) return false;
  const dateCell = pickDateCell(row, map);
  if (!parseStatementDate(dateCell, { dayFirst })) return false;
  const money = [map.debit, map.credit, map.amount]
    .filter((i) => i != null)
    .map((i) => parseAmount(row[i]));
  return money.some((n) => n != null && n !== 0);
}

function pickDateCell(row, map) {
  if (map.date != null && String(row[map.date] ?? "").trim()) return row[map.date];
  if (map.valueDate != null) return row[map.valueDate];
  return map.date != null ? row[map.date] : null;
}

// ---------------------------------------------------------------------------
// Row extraction
// ---------------------------------------------------------------------------

/**
 * Resolve one sheet row into a signed transaction.
 *
 * Three layouts are supported and they are not interchangeable:
 *  - separate Withdrawal / Deposit columns (HDFC)
 *  - one Amount column plus a Dr/Cr flag  (Kotak)
 *  - one signed Amount column             (many card exports)
 *
 * The Kotak layout is the one that silently corrupts data if unhandled: every
 * amount in the file is positive, so without reading the flag column the whole
 * statement imports as income.
 */
export function extractRow(row, map, { dayFirst = true } = {}) {
  const txnDate = parseStatementDate(map.date != null ? row[map.date] : null, { dayFirst });
  const valDate = parseStatementDate(map.valueDate != null ? row[map.valueDate] : null, { dayFirst });
  // The value date is the date the bank reckons the money moved. Kotak's own
  // footer says to reconcile on it, and it is what keeps the quarter-end
  // interest credit (posted 1 July, valued 30 June) inside the statement period.
  const accountingDate = valDate?.iso || txnDate?.iso || null;

  let debit = null;
  let credit = null;
  if (map.debit != null || map.credit != null) {
    const d = parseAmount(row[map.debit]);
    const c = parseAmount(row[map.credit]);
    debit = d == null ? null : Math.abs(d);
    credit = c == null ? null : Math.abs(c);
  }
  if (debit == null && credit == null && map.amount != null) {
    const amount = parseAmount(row[map.amount]);
    if (amount != null) {
      const flag = map.amountSign != null ? signOfFlag(row[map.amountSign]) : null;
      if (flag === "debit") debit = Math.abs(amount);
      else if (flag === "credit") credit = Math.abs(amount);
      else if (amount < 0) debit = Math.abs(amount);
      else credit = amount;
    }
  }

  let balance = map.balance != null ? parseAmount(row[map.balance]) : null;
  if (balance != null && map.balanceSign != null && signOfFlag(row[map.balanceSign]) === "debit") {
    // An overdrawn account reports the balance as a positive number flagged Dr.
    balance = -Math.abs(balance);
  }

  return {
    date: accountingDate,
    txnDate: txnDate?.iso || null,
    txnTime: txnDate?.time || null,
    valueDate: valDate?.iso || null,
    dateAmbiguous: Boolean((valDate || txnDate)?.ambiguous),
    description: cleanText(map.description != null ? row[map.description] : ""),
    reference: cleanText(map.reference != null ? row[map.reference] : ""),
    debit: debit || null,
    credit: credit || null,
    balance,
    serial: map.serial != null ? cleanText(row[map.serial]) : null,
  };
}

function signOfFlag(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/^(dr|debit|d|w|withdrawal)\b/.test(text)) return "debit";
  if (/^(cr|credit|c|dep|deposit)\b/.test(text)) return "credit";
  return null;
}

function cleanText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Letterhead
// ---------------------------------------------------------------------------

// The IFSC is the one identifier in the letterhead that is both machine-readable
// and unambiguous, so the bank is derived from it rather than from the filename.
const IFSC_BANKS = {
  HDFC: "HDFC Bank", KKBK: "Kotak Mahindra Bank", ICIC: "ICICI Bank",
  SBIN: "State Bank of India", UTIB: "Axis Bank", PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda", CNRB: "Canara Bank", IDIB: "Indian Bank",
  IOBA: "Indian Overseas Bank", UBIN: "Union Bank of India", YESB: "Yes Bank",
  INDB: "IndusInd Bank", IDFB: "IDFC First Bank", RATN: "RBL Bank",
  FDRL: "Federal Bank", KARB: "Karnataka Bank", CIUB: "City Union Bank",
  UCBA: "UCO Bank", MAHB: "Bank of Maharashtra", CBIN: "Central Bank of India",
  PYTM: "Paytm Payments Bank", AIRP: "Airtel Payments Bank", UJVN: "Ujjivan SFB",
  HSBC: "HSBC", CITI: "Citibank", SCBL: "Standard Chartered", DEUT: "Deutsche Bank",
};

export function bankFromIfsc(ifsc) {
  if (!ifsc) return null;
  return IFSC_BANKS[String(ifsc).slice(0, 4).toUpperCase()] || null;
}

/**
 * Read the account identity out of the rows above the transaction table.
 *
 * Two layouts have to work: HDFC packs `Account No :50100690137022   OTHER` into
 * one cell, Kotak puts the label `Account No.` in one cell and `5246451104` in
 * the next. So every field is looked for both inside a cell and in the cell to
 * the right of its label.
 */
export function extractStatementMeta(aoa, headerIndex) {
  const above = aoa.slice(0, headerIndex);
  const below = aoa.slice(headerIndex);
  const flatAbove = above.map((r) => (r || []).map((c) => String(c ?? "")).join(" │ ")).join("\n");

  const ifsc = matchFirst(flatAbove, [
    /\bIFSC\s*[:│]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i,
    /\b([A-Z]{4}0[A-Z0-9]{6})\b/,
  ]);
  const accountNumber = labelledValue(above, /account\s*(?:no|number)\b/i, /([0-9]{6,20}|[0-9Xx*]{6,20})/);
  const customerId = labelledValue(above, /(cust\.?\s*(?:id|reln\.?\s*no)|customer\s*id)/i, /([0-9]{4,20})/);
  const micr = matchFirst(flatAbove, [/\bMICR\s*[:│]?\s*([0-9]{6,12})\b/i]);
  const period = extractPeriod(flatAbove);
  const holder = extractHolder(above);

  return {
    bank: bankFromIfsc(ifsc),
    ifsc: ifsc ? ifsc.toUpperCase() : null,
    accountNumber,
    accountLast4: accountNumber ? accountNumber.slice(-4) : null,
    customerId,
    micr,
    accountHolder: holder,
    periodFrom: period.from,
    periodTo: period.to,
    declared: extractDeclaredTotals(above, below),
  };
}

function extractPeriod(flat) {
  const rx = /from\s*[:│]?\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4})\s*(?:│\s*)?(?:to|-|through)\s*[:│]?\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4})/i;
  const m = rx.exec(flat.replace(/\s+/g, " "));
  if (!m) return { from: null, to: null };
  // The period line is itself dated, so it is read day-first only after the same
  // proof the transactions use.
  const hint = detectDayFirst([m[1], m[2]]);
  return {
    from: parseStatementDate(m[1], { dayFirst: hint.dayFirst })?.iso || null,
    to: parseStatementDate(m[2], { dayFirst: hint.dayFirst })?.iso || null,
  };
}

function extractHolder(above) {
  for (const row of above) {
    const first = String(row?.[0] ?? "").trim();
    if (!first) continue;
    const cleaned = first.replace(/^(mr|mrs|ms|dr|shri|smt)\.?\s+/i, "").trim();
    if (/^[A-Z][A-Z .]{5,60}$/.test(cleaned) && /\s/.test(cleaned) && !/BANK|LTD|STATEMENT|ACCOUNT|PAGE/i.test(cleaned)) {
      return cleaned.replace(/\s+/g, " ");
    }
  }
  return null;
}

// Opening / closing / debit / credit totals as the BANK states them. These are
// the numbers the parse is later checked against, so they are read from the
// letterhead and the summary block rather than computed from the rows.
function extractDeclaredTotals(above, below) {
  const out = { opening: null, closing: null, debitTotal: null, creditTotal: null, debitCount: null, creditCount: null };
  const rows = [...above, ...below];

  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map((c) => String(c ?? "").trim());
    const line = cells.join(" ");
    if (/closing\s*balance/i.test(line)) {
      const inline = /closing\s*balance[^0-9-]*([0-9,]+\.?[0-9]*)/i.exec(line);
      if (inline && out.closing == null) out.closing = parseAmount(inline[1]);
      const asOn = /as\s*on\s*\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s*(?:INR)?\s*([0-9,]+\.?[0-9]*)/i.exec(line);
      if (asOn) out.closing = parseAmount(asOn[1]);
    }
    // HDFC's summary is a label row followed by a value row, aligned by column.
    const labelIdx = {};
    cells.forEach((cell, idx) => {
      const t = cell.toLowerCase();
      if (/^opening\s*bal/.test(t)) labelIdx.opening = idx;
      else if (/^closing\s*bal/.test(t)) labelIdx.closing = idx;
      else if (/^debits?$/.test(t)) labelIdx.debitTotal = idx;
      else if (/^credits?$/.test(t)) labelIdx.creditTotal = idx;
      else if (/^dr\s*count$/.test(t)) labelIdx.debitCount = idx;
      else if (/^cr\s*count$/.test(t)) labelIdx.creditCount = idx;
    });
    const keys = Object.keys(labelIdx);
    if (keys.length >= 2) {
      const valueRow = (rows[i + 1] || []).map((c) => String(c ?? "").trim());
      for (const key of keys) {
        const parsed = parseAmount(valueRow[labelIdx[key]]);
        if (parsed != null && out[key] == null) out[key] = parsed;
      }
    }
  }
  return out;
}

function labelledValue(rows, labelRx, valueRx) {
  for (const row of rows) {
    const cells = (row || []).map((c) => String(c ?? ""));
    for (let i = 0; i < cells.length; i++) {
      if (!labelRx.test(cells[i])) continue;
      // Same cell: "Account No :50100690137022   OTHER"
      const after = cells[i].slice(cells[i].search(labelRx));
      const inline = valueRx.exec(after.replace(labelRx, ""));
      if (inline) return inline[1];
      // Next non-empty cell: label and value in adjacent columns.
      for (let j = i + 1; j < cells.length; j++) {
        if (!cells[j].trim()) continue;
        const m = valueRx.exec(cells[j]);
        if (m) return m[1];
        break;
      }
    }
  }
  return null;
}

function matchFirst(text, patterns) {
  for (const rx of patterns) {
    const m = rx.exec(text);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Shape a raw array-of-arrays sheet into transactions plus account identity.
 *
 * @returns {{ok: boolean, reason?: string, rows: object[], meta: object,
 *   mapping: object, headerIndex: number, dateFormat: object, skipped: number}}
 */
export function shapeStatement(aoa, { filename = "" } = {}) {
  const grid = (aoa || []).map((r) => (Array.isArray(r) ? r : [r]));
  if (!grid.length) return failure("empty_sheet", filename);

  // Day-first is decided from every cell in the file before any row is read, so
  // one convention applies to the whole statement.
  const dateFormat = detectDayFirst(grid.flat());
  const header = detectHeaderRow(grid, { dayFirst: dateFormat.dayFirst });
  if (!header) return failure("no_transaction_table", filename, { dateFormat });

  const meta = extractStatementMeta(grid, header.index);
  const rows = [];
  let skipped = 0;
  for (let i = header.index + 1; i < grid.length; i++) {
    if (!isTransactionRow(grid[i], header.map, { dayFirst: dateFormat.dayFirst })) { skipped += 1; continue; }
    const row = extractRow(grid[i], header.map, { dayFirst: dateFormat.dayFirst });
    row.sheetRow = i + 1; // 1-based, so a reported problem is findable in Excel
    rows.push(row);
  }
  if (!rows.length) return failure("no_transaction_rows", filename, { dateFormat, meta, mapping: header.map });

  return {
    ok: true,
    rows,
    meta: { ...meta, filename, rowCount: rows.length },
    mapping: header.map,
    headerIndex: header.index,
    dateFormat,
    skipped,
  };
}

const FAILURE_REASONS = {
  empty_sheet: "the file has no rows",
  no_transaction_table: "no transaction table was found - the header row could not be identified",
  no_transaction_rows: "a header row was found but no rows under it look like transactions",
};

function failure(reason, filename, extra = {}) {
  return {
    ok: false,
    reason,
    message: `Could not read ${filename || "the statement"}: ${FAILURE_REASONS[reason] || reason}.`,
    rows: [],
    meta: { filename, ...(extra.meta || {}) },
    mapping: extra.mapping || {},
    headerIndex: -1,
    dateFormat: extra.dateFormat || null,
    skipped: 0,
  };
}
