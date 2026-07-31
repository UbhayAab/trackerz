// Reads what a bank narration actually means.
//
// A bank statement does not tell you what you spent. It tells you what moved.
// Over the user's two real statements, HDFC reports Rs 8.26 lakh of "debits" -
// but that figure contains credit-card bill payments, mutual-fund purchases, a
// loan foreclosure and Rs 1.4 lakh of the user moving money between their own
// two accounts. Treating those as spending is not a rounding error; it is a
// wrong answer by an order of magnitude.
//
// So every row gets a FLOW TYPE before it gets a category. The flow type is the
// difference between money leaving the user's net worth and money merely
// changing its address.
//
// Narrations are parsed by grammar, not keyword soup: Indian bank rails write
// structured strings and the structure carries the counterparty, the VPA, the
// rail and the free-text note the payer typed. That note ("MOVIE TICKET",
// "PAYMENT ON CRED", "Paid Via Elements") is often the single best category
// signal in the row, and keyword matching throws it away.
//
// Pure and dependency-free.

// ---------------------------------------------------------------------------
// Flow types
// ---------------------------------------------------------------------------

export const FLOW_TYPES = {
  spend: { direction: "expense", countsAsSpending: true, label: "Spending" },
  income: { direction: "income", countsAsIncome: true, label: "Income" },
  p2p_out: { direction: "expense", countsAsSpending: true, label: "Sent to a person" },
  p2p_in: { direction: "income", countsAsIncome: true, label: "Received from a person" },
  self_transfer_out: { direction: "transfer", label: "Moved to your own account" },
  self_transfer_in: { direction: "transfer", label: "Moved from your own account" },
  investment: { direction: "transfer", label: "Invested" },
  investment_return: { direction: "transfer", label: "Investment proceeds" },
  card_payment: { direction: "transfer", label: "Credit card bill" },
  loan_emi: { direction: "expense", countsAsSpending: true, label: "Loan EMI" },
  loan_principal: { direction: "transfer", label: "Loan principal" },
  loan_disbursal: { direction: "transfer", label: "Loan received" },
  refund: { direction: "income", label: "Refund" },
  bank_charge: { direction: "expense", countsAsSpending: true, label: "Bank charge" },
  interest: { direction: "income", countsAsIncome: true, label: "Interest" },
  wallet_load: { direction: "transfer", label: "Wallet top-up" },
  cash: { direction: "expense", countsAsSpending: true, label: "Cash withdrawal" },
  unknown_out: { direction: "expense", countsAsSpending: true, label: "Uncategorised payment" },
  unknown_in: { direction: "income", countsAsIncome: true, label: "Uncategorised receipt" },
};

export function isSpending(flow) {
  return Boolean(FLOW_TYPES[flow]?.countsAsSpending);
}

/**
 * Does this ledger row count toward what the user SPENT?
 *
 * The authority is the stored `counts_as_spending` flag, because the user can
 * reclassify a row and that decision must win. Rows written before flow types
 * existed have neither the flag nor a flow, and fall back to `direction` - the
 * old behaviour, so nothing that predates this changes value.
 */
export function rowCountsAsSpending(row) {
  if (!row) return false;
  if (row.merged_into) return false;
  if (typeof row.counts_as_spending === "boolean") return row.counts_as_spending && row.direction === "expense";
  if (row.flow_type) return isSpending(row.flow_type);
  return row.direction === "expense";
}

export function rowCountsAsIncome(row) {
  if (!row) return false;
  if (row.merged_into) return false;
  if (typeof row.counts_as_income === "boolean") return row.counts_as_income && row.direction === "income";
  if (row.flow_type) return isIncome(row.flow_type);
  return row.direction === "income";
}
export function isIncome(flow) {
  return Boolean(FLOW_TYPES[flow]?.countsAsIncome);
}
export function directionOf(flow) {
  return FLOW_TYPES[flow]?.direction || "expense";
}

// ---------------------------------------------------------------------------
// Narration grammar
// ---------------------------------------------------------------------------

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const RRN_RE = /^\d{9,16}$/;

/**
 * Parse a narration into its parts.
 *
 * @returns {{rail: string, counterparty: string|null, vpa: string|null,
 *   ifsc: string|null, ref: string|null, note: string|null, cardLast4: string|null,
 *   loanAccount: string|null, raw: string}}
 */
export function parseNarration(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  const base = { rail: "other", counterparty: null, vpa: null, ifsc: null, ref: null, note: null, cardLast4: null, loanAccount: null, raw: text };
  if (!text) return base;

  // Kotak appends the value date in brackets to some narrations.
  const body = text.replace(/\(value date:.*?\)\s*$/i, "").trim();

  for (const parser of NARRATION_PARSERS) {
    const hit = parser(body, base);
    if (hit) return { ...base, ...hit, raw: text };
  }
  return base;
}

const NARRATION_PARSERS = [
  // HDFC: UPI-PAYEE NAME-vpa@handle-IFSC-RRN-NOTE
  // Split on "-" then identify each part by SHAPE, because payee names and
  // notes contain hyphens and a positional split mangles them.
  function hdfcUpi(text) {
    if (!/^UPI-/i.test(text)) return null;
    const parts = text.split("-").map((p) => p.trim());
    let vpaIdx = -1, ifscIdx = -1, rrnIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (vpaIdx < 0 && parts[i].includes("@")) vpaIdx = i;
      if (ifscIdx < 0 && IFSC_RE.test(parts[i].toUpperCase())) ifscIdx = i;
      if (rrnIdx < 0 && RRN_RE.test(parts[i])) rrnIdx = i;
    }
    // A VPA split by the hyphen inside it ("UBHAYVATSAANAND-3@OKHDFCBANK")
    // rejoins with the preceding fragment. Only a ONE-OR-TWO digit prefix counts:
    // a ten-digit prefix is a phone-number VPA ("9142072413@YBL") and rejoining
    // it would swallow the payee's name, which is the whole point of the parse.
    let vpa = vpaIdx > 0 ? parts[vpaIdx] : null;
    let nameEnd = vpaIdx > 0 ? vpaIdx : ifscIdx > 0 ? ifscIdx : rrnIdx > 0 ? rrnIdx : parts.length;
    if (vpa && /^\d{1,2}@/.test(vpa) && nameEnd > 1 && !/\s/.test(parts[nameEnd - 1])) {
      vpa = `${parts[nameEnd - 1]}-${vpa}`;
      nameEnd -= 1;
    }
    const counterparty = parts.slice(1, nameEnd).join("-").trim() || null;
    const noteStart = Math.max(rrnIdx, ifscIdx, vpaIdx) + 1;
    const noteParts = noteStart > 0 ? parts.slice(noteStart) : [];
    const note = noteParts.join("-").trim();
    return {
      rail: "upi",
      counterparty,
      vpa: vpa || null,
      ifsc: ifscIdx > 0 ? parts[ifscIdx].toUpperCase() : null,
      ref: rrnIdx > 0 ? parts[rrnIdx] : null,
      // "UPI" as the trailing note means the payer typed nothing.
      note: note && !/^upi$/i.test(note) ? note : null,
    };
  },

  // Kotak: UPI/PAYEE/REF/NOTE  (payee is truncated to ~16 chars by the bank)
  function kotakUpi(text) {
    if (!/^UPI\//i.test(text)) return null;
    const parts = text.split("/").map((p) => p.trim());
    const note = parts.slice(3).join("/").trim();
    return {
      rail: "upi",
      counterparty: parts[1] || null,
      ref: parts[2] || null,
      note: note && !/^upi(intent|)$/i.test(note) ? note : null,
    };
  },

  // A UPI reversal names the RRN of the payment it is reversing, which makes
  // refund pairing exact rather than a same-amount guess.
  function upiReturn(text) {
    const m = /^UPIRET-(\d{8})-(\d{9,16})/i.exec(text);
    if (!m) return null;
    return { rail: "upi", ref: m[2], note: "UPI reversal", reversesRef: m[2] };
  },

  // HDFC: NEFT CR-IFSC-REMITTER-BENEFICIARY-REF
  function hdfcNeft(text) {
    const m = /^(NEFT|RTGS)\s+(CR|DR)-([A-Z]{4}0[A-Z0-9]{6})-(.*)$/i.exec(text);
    if (!m) return null;
    const tail = m[4].split("-").map((p) => p.trim());
    return {
      rail: m[1].toLowerCase(),
      inward: /cr/i.test(m[2]),
      ifsc: m[3].toUpperCase(),
      counterparty: tail[0] || null, // the other party, whichever side we are
      ref: tail.length > 2 ? tail[tail.length - 1] : null,
    };
  },

  // Kotak inward remittance: "NEFT NRE REM AMAZON MEDIA EU S A R L BOFAH2611901".
  // The remitter name runs to the end of a fixed-width column, so the trailing
  // bank reference is often chopped ("...PTE LTD BO"). A trailing token is only
  // treated as a reference when it still looks like one; otherwise the name
  // keeps it, because losing the payer is worse than keeping a stray fragment.
  function kotakInward(text) {
    const m = /^(NEFT|RTGS|IMPS)\s+(?:NRE\s+REM|INW|INWARD)\s+(.+)$/i.exec(text);
    if (!m) return null;
    const tokens = m[2].trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    const hasRef = tokens.length > 1 && /^[A-Z]{2,}\d{4,}$/.test(last);
    return {
      rail: m[1].toLowerCase(),
      inward: true,
      counterparty: (hasRef ? tokens.slice(0, -1) : tokens).join(" "),
      ref: hasRef ? last : null,
    };
  },

  // Kotak: NEFT <bankref> <REMITTER NAME, truncated to the column width>
  function kotakNeft(text) {
    const m = /^(NEFT|RTGS)\s+(?:(NRE\s+REM|INW|OUTW)\s+)?([A-Z0-9]{8,})\s+(.+)$/i.exec(text);
    if (!m) return null;
    return { rail: m[1].toLowerCase(), ref: m[3], counterparty: m[4].trim() || null };
  },
  function kotakNeftRem(text) {
    const m = /^(NEFT|RTGS)\s+NRE\s+REM\s+(.+?)\s+([A-Z]{4}[A-Z0-9]{6,})$/i.exec(text);
    if (!m) return null;
    return { rail: m[1].toLowerCase(), counterparty: m[2].trim(), ref: m[3] };
  },

  // IMPS-REF-BENEFICIARY-BANK-MASKEDACCT-REF2
  function imps(text) {
    const m = /^IMPS-(\d{6,16})-(.*)$/i.exec(text);
    if (!m) return null;
    const tail = m[2].split("-").map((p) => p.trim());
    return { rail: "imps", ref: m[1], counterparty: tail[0] || null };
  },

  // NACH-MUT-DR-INDIAN CLEARING CORP-<mandate ref>: a mutual fund SIP debit.
  function nach(text) {
    const m = /^(NACH|ACH|ECS)[-\s]+(?:([A-Z]{2,4})[-\s]+)?(DR|CR)[-\s]+(.+?)(?:-([A-Z0-9]{10,}))?$/i.exec(text);
    if (!m) return null;
    return { rail: "nach", counterparty: m[4]?.trim() || null, ref: m[5] || null, note: m[2] || null };
  },

  // HDFC internal third-party transfer: <their acct>-TPT-<note>-<name>
  function hdfcTpt(text) {
    const m = /^(\d{9,18})-TPT-(.+?)-([A-Z][A-Z .&]{3,})$/i.exec(text);
    if (!m) return null;
    return { rail: "tpt", ref: m[1], note: cleanNote(m[2]), counterparty: m[3].trim() };
  },

  // IB BILLPAY DR-HDFC5X-653029XXXXXX9097 : a credit card bill paid from netbanking.
  function billpay(text) {
    const m = /^IB\s+BILLPAY\s+(DR|CR)-([A-Z0-9]+)-(\d{0,6}X+(\d{4}))/i.exec(text);
    if (!m) return null;
    return { rail: "billpay", counterparty: "Credit card", cardLast4: m[4], ref: m[2] };
  },

  // EXC PYMT - 6530 XXXX XXXX 9097 : the card refunding an overpayment.
  function excessPayment(text) {
    const m = /^EXC\s+PYMT\s*-?\s*(\d{4})\s*X+\s*X+\s*(\d{4})/i.exec(text);
    if (!m) return null;
    return { rail: "card", counterparty: "Credit card", cardLast4: m[2], note: "Excess payment returned" };
  },

  function emi(text) {
    const m = /^EMI\s+(\d{6,})\b/i.exec(text);
    if (!m) return null;
    return { rail: "loan", counterparty: "Loan EMI", loanAccount: m[1] };
  },

  function loanPayment(text) {
    const m = /PAYMENT\s+TOWARDS\s+LOAN\s+ACCOUNT\s*(\d{6,})/i.exec(text);
    if (!m) return null;
    return { rail: "loan", counterparty: "Loan account", loanAccount: m[1] };
  },

  function loanRefund(text) {
    const m = /^RA\s+REFUND\s+POOL-(\d{6,})/i.exec(text);
    if (!m) return null;
    return { rail: "loan", counterparty: "Loan account", loanAccount: m[1], note: "Loan refund" };
  },

  function foreclosure(text) {
    if (!/FORECLOSURE/i.test(text)) return null;
    const m = /^(?:PG\s+)?LOAN\s+FORECLOSURE\s+(.*)$/i.exec(text);
    return { rail: "loan", counterparty: (m?.[1] || "Loan").trim(), note: "Loan foreclosure" };
  },

  function emiCharge(text) {
    const m = /^(\d{6,})-EMI\s+RTN\s+CHARGES/i.exec(text);
    if (!m) return null;
    return { rail: "charge", counterparty: "EMI return charge", loanAccount: m[1] };
  },

  function charge(text) {
    if (!/^CHRG[:\s]/i.test(text)) return null;
    return { rail: "charge", counterparty: cleanNote(text.replace(/^CHRG[:\s]*/i, "")) || "Bank charge" };
  },

  function interestPaid(text) {
    if (!/^(INT\.?\s*PD|INTEREST\s+PAID|CREDIT\s+INTEREST)/i.test(text)) return null;
    return { rail: "interest", counterparty: "Interest credited" };
  },

  function atm(text) {
    if (!/^(ATW|NWD|ATM|CASH\s+WDL)/i.test(text)) return null;
    return { rail: "atm", counterparty: "ATM withdrawal" };
  },
];

function cleanNote(text) {
  const t = String(text || "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return t && !/^(upi|payment|na|nil)$/i.test(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Owner identity - what counts as "my own money moving"
// ---------------------------------------------------------------------------

/**
 * Build the identity used to recognise the user's own accounts in a narration.
 * Seeded from the statements themselves: importing a Kotak statement teaches the
 * app that KKBK0008109 / 5246451104 is the user's, so a later HDFC row paying
 * that IFSC is recognised as a self-transfer with no configuration at all.
 */
export function buildOwnerIdentity(accounts = [], extraNames = []) {
  const names = new Set();
  const vpaStems = new Set();
  const ifscs = new Set();
  const numbers = new Set();
  for (const acct of accounts) {
    if (acct?.accountHolder) names.add(normalizeName(acct.accountHolder));
    if (acct?.ifsc) ifscs.add(String(acct.ifsc).toUpperCase());
    if (acct?.accountNumber) numbers.add(String(acct.accountNumber));
    for (const v of acct?.vpas || []) vpaStems.add(vpaStem(v));
  }
  for (const n of extraNames) names.add(normalizeName(n));
  names.delete("");
  vpaStems.delete("");
  return {
    names: [...names],
    // Name variants matter: the same person is "ABHAY ANAND VATSA" on one bank
    // and "UBHAY ANAND VATSA" on another, and Kotak truncates both to 15
    // characters. Comparison is therefore prefix- and typo-tolerant.
    vpaStems: [...vpaStems],
    ifscs: [...ifscs],
    accountNumbers: [...numbers],
  };
}

function normalizeName(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/^(MR|MRS|MS|DR|SHRI|SMT)\.?\s+/, "")
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function vpaStem(vpa) {
  return String(vpa || "")
    .toLowerCase()
    .split("@")[0]
    .replace(/[^a-z0-9]/g, "")
    .replace(/\d+$/, "");
}

/**
 * Is this counterparty the user themselves?
 *
 * Truncation is the hard part. Kotak writes "ABHAY ANAND VAT" and "UBHAY  ANAND
 * VA" for the same person the HDFC statement calls "ABHAY ANAND VATSA", so an
 * equality test finds nothing. A prefix match on the shorter string handles the
 * truncation, and a one-character tolerance handles the A/U spelling split
 * across the user's two banks.
 */
export function isOwnCounterparty(parsed, owner) {
  if (!owner) return { own: false, reason: null };
  if (parsed.ifsc && owner.ifscs.includes(parsed.ifsc)) return { own: true, reason: "own_account_ifsc" };
  if (parsed.vpa) {
    const stem = vpaStem(parsed.vpa);
    if (stem && owner.vpaStems.some((s) => s && (s === stem || s.startsWith(stem) || stem.startsWith(s)))) {
      return { own: true, reason: "own_vpa" };
    }
  }
  if (parsed.ref && owner.accountNumbers.includes(String(parsed.ref))) return { own: true, reason: "own_account_number" };
  const name = normalizeName(parsed.counterparty);
  if (name.length >= 8) {
    for (const own of owner.names) {
      if (namesMatch(name, own)) return { own: true, reason: "own_name" };
    }
  }
  return { own: false, reason: null };
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const head = long.slice(0, short.length);
  if (head === short) return true;
  // One substitution tolerated (ABHAY / UBHAY), and only on a long-enough name.
  if (short.length < 10) return false;
  let diff = 0;
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== head[i] && ++diff > 1) return false;
  }
  return diff <= 1;
}

// ---------------------------------------------------------------------------
// Counterparty rules
// ---------------------------------------------------------------------------

// Ordered, first match wins. `flow` may be a function of direction.
const COUNTERPARTY_RULES = [
  // Markets ------------------------------------------------------------------
  { rx: /groww|zerodha|upstox|angel\s*one|kite\b|smallcase|indmoney|coin\s*by/i,
    party: "Groww", flow: (out) => (out ? "investment" : "investment_return"), category: "Investing" },
  { rx: /mutual\s*fund|\bmf\s*(sip|purchase)|nach-mut|bse\s*star|mfss|nse\s*clearing|indian\s*clearing\s*corp|cams\b|kfintech/i,
    party: "Mutual funds", flow: (out) => (out ? "investment" : "investment_return"), category: "Investing" },
  { rx: /nps\s*trust|national\s*pension/i, party: "NPS", flow: () => "investment", category: "Investing" },

  // Credit cards -------------------------------------------------------------
  { rx: /ib\s*billpay|cc\s*payment|credit\s*card\s*payment|card\s*bill/i,
    party: "Credit card", flow: () => "card_payment", category: "Credit card" },
  { rx: /cred\.club|cred\s*(club|ccbp)|credccbp|payment\s*on\s*cred/i,
    party: "CRED", flow: (out) => (out ? "card_payment" : "refund"), category: "Credit card" },
  { rx: /exc\s*pymt/i, party: "Credit card", flow: () => "refund", category: "Credit card" },

  // Loans --------------------------------------------------------------------
  { rx: /foreclosure/i, party: "Loan", flow: () => "loan_principal", category: "Loan" },
  { rx: /payment\s*towards\s*loan|loan\s*repay|principal\s*repay/i, party: "Loan", flow: () => "loan_principal", category: "Loan" },
  { rx: /^emi\b|\bemi\s*\d|loan\s*emi|\bemi\s*debit/i, party: "Loan EMI", flow: () => "loan_emi", category: "Loan" },
  { rx: /ra\s*refund\s*pool/i, party: "Loan", flow: () => "refund", category: "Loan" },
  { rx: /loan\s*disburs/i, party: "Loan", flow: () => "loan_disbursal", category: "Loan" },

  // Bank's own charges and interest -----------------------------------------
  { rx: /rtn\s*charges|return\s*charge|chrg[:\s]|\bcharges?\b.*\b(mandate|ecs|nach|sms|amb|min\s*bal)|gst\s*on|service\s*charge|penal/i,
    party: "Bank charge", flow: () => "bank_charge", category: "Bank charges" },
  { rx: /int\.?\s*pd|interest\s*paid|credit\s*interest|saving.*interest/i,
    party: "Interest", flow: () => "interest", category: "Interest" },

  // Wallets and cash ---------------------------------------------------------
  { rx: /amazon\s*pay\s*bala|paytm\s*wallet|wallet\s*load|add\s*money/i,
    party: "Wallet", flow: () => "wallet_load", category: "Wallet" },
  { rx: /^(atw|nwd|atm|cash\s*wdl)/i, party: "ATM", flow: () => "cash", category: "Cash" },

  // Everyday merchants -------------------------------------------------------
  { rx: /zepto|blinkit|bigbasket|big\s*basket|instamart|dmart|d-?mart|jiomart|grofers/i, party: null, category: "Groceries" },
  { rx: /swiggy|zomato|dominos|mcdonald|kfc|starbucks|burger\s*king|cafe|restaurant|bakery|biryani|dhaba|eatery|food\s*court/i,
    party: null, category: "Eating out" },
  { rx: /namma\s*yatri|uber|\bola\b|rapido|metro\s*rail|bmrc|bmtc|irctc|indian\s*railways|redbus|blablacar/i,
    party: null, category: "Transport" },
  { rx: /makemytrip|goibibo|cleartrip|ixigo|yatra|easemytrip|airbnb|oyo\b|booking\.com|indigo|air\s*india|vistara|spicejet/i,
    party: null, category: "Travel" },
  { rx: /indian\s*oil|iocl|\bhpcl\b|\bbpcl\b|bharat\s*petroleum|hindustan\s*petroleum|shell|nayara|petrol|fuel/i,
    party: null, category: "Fuel" },
  { rx: /netflix|spotify|hotstar|prime\s*video|youtube\s*premium|google\s*play|google\s*india|apple\.com|adobe|openai|chatgpt|anthropic|claude|github|notion|figma|canva|zvc\s*india|\bzoom\b|microsoft|jetbrains/i,
    party: null, category: "Subscriptions" },
  { rx: /airtel|jio\b|vodafone|\bvi\s|bsnl|tata\s*play|act\s*fibernet|hathway|broadband|recharge/i,
    party: null, category: "Phone and internet" },
  { rx: /bescom|electricity|water\s*board|bwssb|gas\s*ltd|indane|hp\s*gas|bharat\s*gas|piped\s*gas/i,
    party: null, category: "Utilities" },
  { rx: /apollo|pharmeasy|1mg|netmeds|practo|hospital|clinic|diagnostic|pharmacy|medical|dental/i,
    party: null, category: "Health" },
  { rx: /amazon|flipkart|myntra|ajio|meesho|nykaa|croma|reliance\s*digital|decathlon|lenskart|ikea/i,
    party: null, category: "Shopping" },
  { rx: /bookmyshow|pvr\b|inox|cinepolis|movie\s*ticket|district\b/i, party: null, category: "Entertainment" },
  { rx: /rent\b|landlord|nobroker|housing\.com/i, party: null, category: "Rent" },
  { rx: /insurance|policybazaar|lic\s*of\s*india|hdfc\s*life|icici\s*pru|star\s*health/i, party: null, category: "Insurance" },
  { rx: /gym|cult\.?fit|fitness|yoga/i, party: null, category: "Fitness" },
  { rx: /unacademy|byju|coursera|udemy|upgrad|scaler|school|college|university|tuition|exam\s*fee/i,
    party: null, category: "Education" },
  { rx: /foundation|trust\b|ngo\b|donation|charit/i, party: null, category: "Charity and giving" },
  { rx: /releasemyad|solve4x|razorpay|payu|cashfree|instamojo|\bads?\b\s*(payment|spend)|advertis/i,
    party: null, category: "Business services" },
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify one shaped statement row.
 *
 * @param {object} row - {date, debit, credit, description, reference, ...}
 * @param {object} ctx - {owner, employers?: string[]}
 * @returns {{flow: string, direction: string, category: string|null,
 *   counterparty: string|null, parsed: object, confidence: number, reasons: string[]}}
 */
export function classifyTransaction(row, ctx = {}) {
  const outgoing = Boolean(row.debit);
  const parsed = parseNarration(row.description);
  const probe = categoryProbe(row, parsed);
  const reasons = [];

  // 1. Own money moving between own accounts wins over everything. It is the
  //    largest single distortion in a multi-account statement set and the one
  //    the user can least afford to have counted as spending.
  const own = isOwnCounterparty(parsed, ctx.owner);
  if (own.own) {
    reasons.push(own.reason);
    return finish(outgoing ? "self_transfer_out" : "self_transfer_in", "Own account", "Transfers", parsed, 0.97, reasons);
  }

  // 2. Structural signals from the narration grammar, which are stronger than
  //    any keyword because the bank generated them.
  if (parsed.rail === "billpay") {
    reasons.push("billpay_narration");
    return finish("card_payment", `Credit card ••${parsed.cardLast4 || "?"}`, "Credit card", parsed, 0.96, reasons);
  }
  if (parsed.rail === "loan") {
    const flow = /foreclosure/i.test(probe) ? "loan_principal"
      : /refund/i.test(probe) ? "refund"
      : /^emi/i.test(parsed.raw) ? "loan_emi"
      : outgoing ? "loan_principal" : "loan_disbursal";
    reasons.push("loan_narration");
    return finish(flow, parsed.counterparty || "Loan", "Loan", parsed, 0.94, reasons);
  }
  if (parsed.rail === "charge") {
    reasons.push("charge_narration");
    return finish("bank_charge", parsed.counterparty || "Bank charge", "Bank charges", parsed, 0.95, reasons);
  }
  if (parsed.rail === "interest") {
    reasons.push("interest_narration");
    return finish("interest", "Interest", "Interest", parsed, 0.96, reasons);
  }
  if (parsed.rail === "atm") {
    reasons.push("atm_narration");
    return finish("cash", "ATM", "Cash", parsed, 0.95, reasons);
  }
  if (parsed.reversesRef) {
    reasons.push("upi_reversal");
    return finish("refund", parsed.counterparty || "Reversal", "Refunds", parsed, 0.95, reasons);
  }

  const kind = counterpartyKind(parsed);

  // 3. Named counterparties.
  for (const rule of COUNTERPARTY_RULES) {
    if (!rule.rx.test(probe)) continue;
    reasons.push("counterparty_rule");
    const flow = rule.flow ? rule.flow(outgoing) : null;
    const party = rule.party || titleCase(parsed.counterparty) || null;
    if (flow) return finish(flow, party, rule.category, parsed, 0.9, reasons);
    // Money coming BACK from a known merchant is not automatically a refund.
    // A refund is relational - it only exists if an earlier debit matches it -
    // so that call belongs to the linker, which can see both rows. Guessing it
    // here read Rs 5.3 lakh of Meesho seller payouts as "refunds".
    if (outgoing) return finish("spend", party, rule.category, parsed, 0.85, reasons);
    // A named company paying in on a business rail is income and is not worth
    // asking about - these are the user's payroll and marketplace payouts, and
    // at 0.7 the five largest receipts of the half-year all landed in review.
    const corporate = kind.kind === "merchant" && ["neft", "rtgs", "imps", "nach", "tpt"].includes(parsed.rail);
    return finish("income", party, "Income", parsed, corporate ? 0.85 : 0.7, reasons);
  }

  // 4. Known income sources learned from history (payroll, marketplaces).
  if (!outgoing && matchesAny(probe, ctx.employers)) {
    reasons.push("known_income_source");
    return finish("income", titleCase(parsed.counterparty), "Income", parsed, 0.9, reasons);
  }

  // 5. A company on a business rail is income/spend; a person on the same rail
  //    is neither - it is money between people, which is its own thing.
  const merchant = kind.kind === "merchant";
  const person = kind.kind === "person";
  if (["neft", "rtgs", "imps", "nach", "tpt"].includes(parsed.rail)) {
    reasons.push(`${parsed.rail}_${kind.kind}`);
    if (!outgoing) return finish(person ? "p2p_in" : "income", titleCase(parsed.counterparty), person ? "People" : "Income", parsed, merchant ? 0.82 : 0.66, reasons);
    return finish(person ? "p2p_out" : "spend", titleCase(parsed.counterparty), person ? "People" : null, parsed, merchant ? 0.72 : 0.62, reasons);
  }

  // 6. UPI. A registered merchant is spending; a private individual is not.
  //    Deliberately NOT given an invented category - a wrong category is worse
  //    than none, because the user has to disprove it, and there are 50 of these.
  if (parsed.rail === "upi") {
    if (merchant) {
      reasons.push(`upi_merchant:${kind.reason}`);
      return finish(outgoing ? "spend" : "income", titleCase(parsed.counterparty), null, parsed, 0.75, reasons);
    }
    reasons.push(person ? `upi_person:${kind.reason}` : "upi_unknown_party");
    return finish(outgoing ? "p2p_out" : "p2p_in", titleCase(parsed.counterparty), "People", parsed, person ? 0.72 : 0.55, reasons);
  }

  reasons.push("unclassified");
  return finish(outgoing ? "unknown_out" : "unknown_in", titleCase(parsed.counterparty), null, parsed, 0.4, reasons);
}

/**
 * The text category rules are allowed to read.
 *
 * The VPA and the IFSC are deliberately cut out. They name the payment
 * processor, not the merchant, and reading them produces confident nonsense:
 * an ad agency paid through Razorpay's Airtel-bank handle carries
 * `...RZP@RXAIRTEL`, which matched the Airtel telecom rule and filed three
 * business payments under "Phone and internet". Merchant-vs-person detection
 * still reads the VPA - that is what it is for - but category naming must not.
 */
function categoryProbe(row, parsed) {
  let text = String(row.description || "");
  for (const token of [parsed.vpa, parsed.ifsc]) {
    if (token) text = text.split(token).join(" ");
  }
  return `${text} ${parsed.note || ""} ${row.reference || ""}`;
}

function finish(flow, counterparty, category, parsed, confidence, reasons) {
  return {
    flow,
    direction: directionOf(flow),
    category: category || null,
    counterparty: counterparty || null,
    parsed,
    confidence,
    reasons,
  };
}

function matchesAny(text, list) {
  if (!list?.length) return false;
  const t = String(text).toLowerCase();
  return list.some((needle) => needle && t.includes(String(needle).toLowerCase()));
}

const COMPANY_SUFFIX = /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|technologies|technolo|solutions|services|enterprises|industries|india|foundation|trust|company|co|store|stores|retail|marketplace|mktp|systems|labs|ventures|capital|finance|bank|insurance|hospital|clinic|school|college|university|motors|traders|agencies|associates|international|global|holdings|hldgs|group|media|networks|digital|infotech|software|consult\w*)\b/i;

// UPI encodes merchant-vs-person in the plumbing, and that is far more reliable
// than reading the name. A registered merchant is settled through a merchant
// IFSC (the literal strings MER/MCH/MGS/PTM appear in it) or holds a PSP
// merchant VPA (a PaytmQR code, a Razorpay `.rzp@`, a PayU `.payu@`). A private
// individual on Google Pay always ends up on an `@ok<bank>` handle, and a
// phone-number VPA is a person by construction. Without this, "UPI/KIRAN/..."
// and "UPI-DEEPAK-PAYTMQR6VWL5S@PTYS-..." are indistinguishable by name - yet
// one is a friend and the other is the tea stall.
const MERCHANT_IFSC = /0(MER|MCH|MGS|PTM|JPU)/i;
// Consumer payment apps (@superyes, @fam, @jupiteraxis) are deliberately NOT
// here: they are how private individuals pay, so listing them turned a Rs 4,000
// payment to a person into a merchant purchase.
const MERCHANT_VPA = /paytmqr|\.rzp@|\.payu@|\.easebuzz|\.ibz@|@ptys|@paytm\b|@kotakpay|@valid|@rxairtel|@ypbiz|@axisbank\b|@hdfcbank\b|@abfspay|^q\d{6,}@|bizpay/i;
const PERSONAL_VPA = /@ok(hdfcbank|icici|sbi|axis)\b|@(ybl|ibl|axl|apl|upi|sbi|pthdfc|ptyes|ptaxis|jupiteraxis|fam|naviaxis|slc|timecosmos)$/i;

/**
 * Merchant, person, or unknown - decided from the payment rails first and the
 * name only as a fallback.
 */
export function counterpartyKind(parsed) {
  const vpa = String(parsed?.vpa || "");
  const ifsc = String(parsed?.ifsc || "");
  if (vpa && MERCHANT_VPA.test(vpa)) return { kind: "merchant", reason: "merchant_vpa" };
  if (ifsc && MERCHANT_IFSC.test(ifsc)) return { kind: "merchant", reason: "merchant_ifsc" };
  if (looksLikeCompany(parsed?.counterparty)) return { kind: "merchant", reason: "company_name" };
  if (vpa && (PERSONAL_VPA.test(vpa) || /^\d{10}(-\d)?@/.test(vpa))) return { kind: "person", reason: "personal_vpa" };
  if (parsed?.counterparty && looksLikePersonName(parsed.counterparty)) return { kind: "person", reason: "person_name" };
  return { kind: "unknown", reason: null };
}

export function looksLikeCompany(name) {
  const text = String(name || "").trim();
  if (!text) return false;
  return COMPANY_SUFFIX.test(text);
}

const HONORIFIC = /^(mr|mrs|ms|dr|shri|smt|sri)\b/i;

function looksLikePersonName(name) {
  const text = String(name || "").trim();
  if (!text || COMPANY_SUFFIX.test(text)) return false;
  if (HONORIFIC.test(text)) return true;
  // Two or three alphabetic words with no digits reads as a personal name.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Za-z.]{1,20}$/.test(w));
}

export function titleCase(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Pvt|Ltd|Llp|Upi|Neft|Imps|Rtgs|Nach|Hdfc|Icici|Sbi|Nse|Bse)\b/g, (m) => m.toUpperCase());
}
