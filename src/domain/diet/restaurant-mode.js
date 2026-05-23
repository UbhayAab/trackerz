// Best-effort parser for OCR-extracted restaurant bills.
// No AI calls — we look for lines that end in a currency amount and treat the
// rest as the item name. Subtotal / tax / total lines are recognised by
// keyword and pulled out of the item list.

const AMOUNT_RE = /([₹Rr][sS]?\.?\s*)?(\d{1,3}(?:[, ]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*$/;
const KEYWORD_RES = {
  subtotal: /\b(sub[- ]?total|sub tl)\b/i,
  tax: /\b(tax|gst|cgst|sgst|igst|vat|service\s*charge)\b/i,
  total: /\b(grand\s*total|total\s*amount|net\s*amount|amount\s*payable|total)\b/i,
  discount: /\b(discount|disc\.?|off)\b/i,
};

function parseAmount(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[₹RrSs.\s,]/g, (m) => (m === "." ? "." : ""));
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractAmountFromLine(line) {
  const match = line.match(AMOUNT_RE);
  if (!match) return null;
  const amount = parseAmount(match[2]);
  if (amount == null) return null;
  const name = line.slice(0, match.index).trim().replace(/[-:.\s]+$/, "");
  return { name, amount };
}

function classify(line) {
  if (KEYWORD_RES.total.test(line) && !KEYWORD_RES.subtotal.test(line)) return "total";
  if (KEYWORD_RES.subtotal.test(line)) return "subtotal";
  if (KEYWORD_RES.tax.test(line)) return "tax";
  if (KEYWORD_RES.discount.test(line)) return "discount";
  return "item";
}

export function parseRestaurantBill(text) {
  const result = { items: [], subtotal: null, tax: null, total: null, discount: null };
  if (!text) return result;
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let taxAccum = 0;
  let taxSeen = false;

  for (const line of lines) {
    const parsed = extractAmountFromLine(line);
    if (!parsed) continue;
    const kind = classify(line);
    if (kind === "total") {
      result.total = parsed.amount;
    } else if (kind === "subtotal") {
      result.subtotal = parsed.amount;
    } else if (kind === "tax") {
      taxAccum += parsed.amount;
      taxSeen = true;
    } else if (kind === "discount") {
      result.discount = parsed.amount;
    } else {
      if (parsed.name) {
        result.items.push({ name: parsed.name, amount: parsed.amount });
      }
    }
  }

  if (taxSeen) result.tax = Number(taxAccum.toFixed(2));

  if (result.subtotal == null && result.items.length) {
    result.subtotal = Number(
      result.items.reduce((sum, it) => sum + it.amount, 0).toFixed(2),
    );
  }

  if (result.total == null && result.subtotal != null) {
    const tax = result.tax || 0;
    const disc = result.discount || 0;
    result.total = Number((result.subtotal + tax - disc).toFixed(2));
  }

  return result;
}

export default parseRestaurantBill;
