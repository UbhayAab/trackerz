// Best-effort bank statement format detection from filename + headers.
// Returns one of: hdfc, sbi, icici, axis, kotak, indusind, bob, pnb, yes,
// idfc, amex, hdfc_cc, sbi_cc, paytm, amazonpay, phonepe_wallet, unknown.
// Used to pick a default column mapping; the user can always override.

const SIGNATURES = [
  { key: "hdfc_cc",         test: /hdfc.*(credit|card|statement)|credit.*hdfc/ },
  { key: "hdfc",            test: /hdfc/ },
  { key: "icici_cc",        test: /icici.*(credit|card)/ },
  { key: "icici",           test: /icici/ },
  { key: "sbi_cc",          test: /sbi.*(card|credit)|state.*bank.*card/ },
  { key: "sbi",             test: /\bsbi\b|state\s*bank/ },
  { key: "axis_cc",         test: /axis.*(card|credit)/ },
  { key: "axis",            test: /axis/ },
  { key: "kotak",           test: /kotak/ },
  { key: "indusind",        test: /indus|induslnd/ },
  { key: "bob",             test: /\bbob\b|baroda/ },
  { key: "pnb",             test: /\bpnb\b|punjab\s*national/ },
  { key: "yes",             test: /\byes\s*bank|yesbank/ },
  { key: "idfc",            test: /idfc|first\s*bank/ },
  { key: "amex",            test: /amex|american\s*express/ },
  { key: "paytm",           test: /paytm/ },
  { key: "amazonpay",       test: /amazon\s*pay|apay/ },
  { key: "phonepe_wallet",  test: /phonepe/ },
  { key: "rbl",             test: /\brbl\b|ratnakar/ },
  { key: "citi",            test: /citi(bank)?/ },
];

export function detectBankFormat({ filename = "", headers = [], sampleText = "" } = {}) {
  const probe = `${filename} ${headers.join(" ")} ${sampleText}`.toLowerCase();
  for (const sig of SIGNATURES) {
    if (sig.test.test(probe)) return sig.key;
  }
  return "unknown";
}

// Header signature fingerprints used by interactive disambiguation when
// detectBankFormat returns "unknown".
export function bankSignature(headers = []) {
  return headers
    .map((h) => String(h).trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join("|");
}

export const KNOWN_BANK_KEYS = SIGNATURES.map((s) => s.key);
