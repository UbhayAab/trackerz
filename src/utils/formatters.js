import { isResult } from "../../lib/failure.mjs";

export function usd(value) {
  return `$${value.toFixed(2)}`;
}

export function inr(value) {
  return `Rs ${Number(value).toLocaleString("en-IN")}`;
}

export function percent(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * The glyph for "we do not have this number". A plain hyphen, not an em dash -
 * this repo bans em/en dashes everywhere, and it already matches the `fmt()`
 * placeholder the dashboard tiles have used since they were written.
 */
export const NOT_MEASURED = "-";

/**
 * fmtMetric(result, fmt) - render a metric that might not exist.
 *
 * The single highest-value line in the failure-surfacing phase: **a tile whose
 * read FAILED must never render a number that looks measured.** The whole
 * documented disease of this app is a failure and a clean zero producing
 * identical pixels - "Rs 0 spent today" for a day whose ledger read 401'd, a
 * "PROTEIN 0g v 100%" tile for a day nothing was logged on. Both are the app
 * asserting a measurement it never took.
 *
 * Rules:
 *   - an Err result            -> "-"   (never 0, never "Rs 0")
 *   - an Ok result holding
 *     null/undefined/NaN       -> "-"   (absent is not measured-zero)
 *   - a bare null/undefined/NaN-> "-"   (so it is a drop-in for the old fmt())
 *   - anything else            -> fmt(value)
 *
 * `fmt` is the formatter for the MEASURED case only; it is never called with an
 * absent value, so formatters do not each need their own null branch.
 */
export function fmtMetric(result, fmt = (v) => String(v)) {
  if (isResult(result)) {
    if (!result.ok) return NOT_MEASURED;
    return fmtMetric(result.value, fmt);
  }
  if (result === null || result === undefined) return NOT_MEASURED;
  if (typeof result === "number" && !Number.isFinite(result)) return NOT_MEASURED;
  return fmt(result);
}
