// FAILURE - one vocabulary for "this read did not work", so a failure can be
// SURFACED instead of silently becoming a number.
//
// This module exists because of a repeating, documented disease in this repo:
// things are computed and then never shown, and a failure looks identical to a
// clean zero.
//   - The cross-source dedupe pipeline went dark for weeks because a thrown
//     exception and "scanned cleanly, found nothing" produced the same UI.
//   - 19 of 89 captures in one audit window wrote zero rows with no error
//     anywhere on screen or in the logs.
//   - The 14:30 cron slot returned HTTP 400 every day since it was written; the
//     workflow piped the body to `head` and exited 0, so CI stayed green.
//   - `src/analytics/period-aggregator.js` used to emit a measured `0` for a day
//     with no rows, which then flowed into trend lines as "you ate nothing".
//
// Pure and isomorphic (no DOM, no Supabase, no fetch) so tests and the browser
// share it byte for byte.

/**
 * The CLOSED set of failure kinds. Closed on purpose: an open set turns back
 * into free-text error strings, which is how "Something went wrong" happens.
 */
export const KINDS = Object.freeze([
  "ok",           // no failure
  "empty",        // the read worked and there was genuinely nothing there
  "unauthorized", // 401/403, expired JWT, RLS refusal - signing in again may fix it
  "offline",      // no network reached the server at all
  "timeout",      // the request was aborted or the server never answered
  "server",       // the server answered, and the answer was a failure (5xx, 429)
  "schema",       // the request does not match the DB/API shape (PGRST204 et al)
  "conflict",     // a write lost a race or violated a constraint
  "unknown",      // classify() could not place it - never silently treat as ok
]);

/**
 * Kinds worth trying again. `unauthorized`, `schema` and `conflict` are NOT:
 * retrying them just burns the user's battery and hides the real fix.
 */
export const RETRYABLE_KINDS = Object.freeze(["offline", "timeout", "server"]);

// PostgREST error codes. PGRST204 is the schema-cache trap this repo has been
// bitten by: a column that exists in the database but not in PostgREST's cached
// schema fails EVERY write until the cache is reloaded, and the message
// ("Could not find the 'x' column of 'y' in the schema cache") reads like a
// typo rather than a deploy step.
const POSTGREST_KINDS = {
  PGRST100: "schema",     // parse error in the query string
  PGRST102: "schema",     // invalid request body
  PGRST103: "schema",     // invalid range
  PGRST106: "schema",     // schema not in the exposed list
  PGRST116: "empty",      // .single()/.maybeSingle() matched 0 rows - not a failure
  PGRST200: "schema",     // no relationship found between tables
  PGRST202: "schema",     // function not found in the schema cache
  PGRST203: "schema",     // ambiguous function overload
  PGRST204: "schema",     // COLUMN NOT FOUND IN SCHEMA CACHE - the trap
  PGRST301: "unauthorized", // JWT expired / invalid
  PGRST302: "unauthorized", // anonymous access disabled
};

// Native Postgres SQLSTATE codes that reach the client through PostgrestError.
const PG_SQLSTATE_KINDS = {
  "42501": "unauthorized", // insufficient_privilege - an RLS policy said no
  "42P01": "schema",       // undefined_table
  "42703": "schema",       // undefined_column
  "42883": "schema",       // undefined_function
  "22P02": "schema",       // invalid_text_representation (uuid/enum mismatch)
  "23502": "schema",       // not_null_violation
  "23503": "conflict",     // foreign_key_violation
  "23505": "conflict",     // unique_violation - the idempotency path
  "23514": "conflict",     // check_violation
  "40001": "conflict",     // serialization_failure
  "40P01": "conflict",     // deadlock_detected
  "57014": "timeout",      // query_canceled (statement_timeout)
  "53300": "server",       // too_many_connections
  "08006": "offline",      // connection_failure
};

function statusOf(err) {
  const raw = err?.status
    ?? err?.statusCode
    ?? err?.context?.status
    ?? err?.response?.status
    ?? err?.originalError?.status;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function kindFromStatus(status) {
  if (!status) return "";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "server";     // endpoint/function is not there at all
  if (status === 408) return "timeout";
  if (status === 409) return "conflict";
  if (status === 429) return "server";     // rate limited: the server answered "no, later"
  if (status === 502 || status === 503 || status === 504) return "server";
  if (status >= 500) return "server";
  if (status >= 400) return "schema";      // a 4xx we did not name is a bad request shape
  return "";
}

/**
 * classify(err) -> one of KINDS.
 *
 * Accepts anything a Supabase call can hand back: a PostgrestError (a plain
 * object, NOT an Error), a StorageError, a FunctionsHttpError/FunctionsFetchError,
 * a DOMException from AbortController, a TypeError from fetch, or a string.
 * `null`/`undefined` means "there was no error" and classifies as "ok" - so a
 * caller can pipe `{ data, error }` straight through without a branch.
 */
export function classify(err) {
  if (err === null || err === undefined || err === false) return "ok";
  if (typeof err === "string") return classify({ message: err });

  const code = err.code === undefined || err.code === null ? "" : String(err.code);
  const name = String(err.name || "");
  const message = String(err.message || "");
  const lower = `${name} ${message}`.toLowerCase();

  // 1. Explicit codes win - they are the most specific thing we ever get.
  if (POSTGREST_KINDS[code]) return POSTGREST_KINDS[code];
  if (PG_SQLSTATE_KINDS[code]) return PG_SQLSTATE_KINDS[code];

  // 2. Abort/timeout: an AbortError from a user-cancelled or timed-out fetch is
  //    NOT a server failure and must never be reported as one.
  if (name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT") return "timeout";
  if (/\btimed? ?out\b|\baborted\b|signal is aborted/.test(lower)) return "timeout";

  // 3. Network-level failure. `TypeError: Failed to fetch` (Chrome),
  //    `NetworkError when attempting to fetch resource` (Firefox) and
  //    `Load failed` (Safari) all mean the request never reached the server -
  //    including "the edge function is not deployed" and "CORS said no".
  if (name === "FunctionsFetchError") return "offline";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EAI_AGAIN") return "offline";
  if (/failed to fetch|networkerror|network request failed|load failed|failed to send a request|fetch failed|network ?error/.test(lower)) {
    return "offline";
  }

  // 4. HTTP status, wherever the client hid it.
  const byStatus = kindFromStatus(statusOf(err));
  if (byStatus) return byStatus;

  // 5. Last-resort message shapes for clients that give us nothing else.
  if (/\bjwt\b|not authori[sz]ed|unauthori[sz]ed|permission denied|row-level security|invalid api key/.test(lower)) {
    return "unauthorized";
  }
  if (/schema cache|does not exist|unknown column|column .* of .* in the schema/.test(lower)) return "schema";
  if (/duplicate key|already exists|conflict/.test(lower)) return "conflict";
  if (/internal server error|bad gateway|service unavailable/.test(lower)) return "server";

  // Deliberately NOT "ok". An error we cannot name is still an error; calling it
  // ok is the exact bug this module exists to stop.
  return "unknown";
}

/** True when retrying the same call could plausibly succeed. */
export function isRetryable(kind) {
  return RETRYABLE_KINDS.includes(kind);
}

/**
 * Ok(value, meta) - a successful read.
 * `meta.source` is the name the degraded banner shows the user, so pass it:
 * "Money and reminders could not be loaded" is only possible if the result
 * knows it was the money read.
 */
export function Ok(value, meta = {}) {
  return { ok: true, kind: "ok", value, error: null, message: "", retryable: false, meta };
}

/**
 * Err(kind, err, meta) - a failed read.
 * `kind` may be omitted (pass the error first) and it will be classified.
 * The shape carries `retryable` so a caller never has to re-derive it.
 */
export function Err(kind, err = null, meta = {}) {
  let k = kind;
  let cause = err;
  if (typeof k !== "string" || !KINDS.includes(k)) {
    // Called as Err(error, meta): classify and shift the arguments.
    cause = kind;
    if (err && typeof err === "object" && !meta.source && !(err instanceof Error)) meta = err;
    k = classify(cause);
  }
  if (k === "ok") k = "unknown"; // an Err is never "ok", whatever classify said
  return {
    ok: false,
    kind: k,
    value: undefined,
    error: cause ?? null,
    message: shortMessage(cause) || k,
    retryable: isRetryable(k),
    meta,
  };
}

/** True for anything produced by Ok()/Err(). Used to keep fmtMetric honest. */
export function isResult(x) {
  return Boolean(x) && typeof x === "object" && typeof x.ok === "boolean" && typeof x.kind === "string";
}

/**
 * unwrapOr(result, fallback) - the ONLY sanctioned way to default a failed read.
 *
 * Everything else (`|| []`, `?? 0`, `.catch(() => [])`) is caught by
 * tests/no-swallowed-errors.test.mjs. Routing every default through one named
 * function makes defaulting greppable: you can list every place in the app
 * where a failure silently becomes a value, which was impossible before.
 */
export function unwrapOr(result, fallback) {
  if (!isResult(result)) return result === undefined || result === null ? fallback : result;
  return result.ok ? result.value : fallback;
}

/**
 * isDegraded(results) -> { degraded, failing }
 *
 * Accepts an array of results (each carrying meta.source) or a plain
 * { sourceName: result } map. `failing` is the list of SOURCE NAMES, because a
 * banner that cannot name what broke is "Something went wrong" one level up -
 * the same disease, just higher in the stack.
 */
export function isDegraded(results) {
  const failing = [];
  const entries = Array.isArray(results)
    ? results.map((r, i) => [r?.meta?.source ?? String(i), r])
    : Object.entries(results || {});
  for (const [name, result] of entries) {
    if (!isResult(result)) continue;   // not a tracked read - say nothing about it
    if (result.ok) continue;
    const label = result.meta?.source || name;
    if (!failing.includes(label)) failing.push(label);
  }
  return { degraded: failing.length > 0, failing };
}

/**
 * describeError(err) -> a human string with the real reason in it.
 *
 * Promoted verbatim (behaviour-wise) out of src/pages/diagnostics.js, which was
 * the only surface in the app that flattened these properly. Supabase reports
 * failures as plain objects, not Errors: PostgrestError carries code/details/hint,
 * StorageError carries a status, and FunctionsHttpError hides the real reason in
 * an unread Response body. Flattening all of it is the difference between an
 * actionable row and "[object Object]".
 *
 * Async because reading the FunctionsHttpError body is async. Use
 * describeErrorSync() where you cannot await.
 */
export async function describeError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const parts = staticParts(err);
  const body = await readErrorBody(err);
  if (body) parts.push(body);
  if (!parts.length) parts.push(stringifyUnknown(err));
  return parts.join(" - ");
}

/** The same flattening minus the Response body, for synchronous call sites. */
export function describeErrorSync(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const parts = staticParts(err);
  if (!parts.length) parts.push(stringifyUnknown(err));
  return parts.join(" - ");
}

function staticParts(err) {
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.code) parts.push(`code ${err.code}`);
  if (err.status || err.context?.status) parts.push(`http ${err.status || err.context.status}`);
  if (err.details) parts.push(String(err.details));
  if (err.hint) parts.push(`hint: ${err.hint}`);
  return parts;
}

async function readErrorBody(err) {
  const ctx = err.context;
  if (!ctx || typeof ctx.text !== "function") return "";
  try {
    const text = (await ctx.text()).trim();
    return text.slice(0, 300);
  } catch {
    return ""; // body already consumed or not readable; the rest of the detail still stands
  }
}

function stringifyUnknown(err) {
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch (jsonErr) {
    // Circular, or holding something JSON cannot carry (a Response, a DOM node).
    // Name that instead of swallowing it: "[object Object]" with no explanation
    // is precisely the dead end this whole module exists to remove.
    return `${String(err)} (not serialisable: ${String(jsonErr?.message || jsonErr)})`;
  }
  return String(err);
}

/** A one-line reason for the result's `message` field. */
function shortMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return String(err.message || err.details || err.hint || "").slice(0, 200);
}
