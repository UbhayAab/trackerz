// FAILURE SURFACING - behaviour of the three pieces that let a failed read be
// seen instead of silently becoming a number:
//   lib/failure.mjs           - classify / Ok / Err / unwrapOr / isDegraded / describeError
//   src/utils/formatters.js   - fmtMetric, the one line that stops a failed tile
//                               rendering a measured-looking 0
//   src/ui/degraded-banner.js - the surface that NAMES the failing sources
//
// Every case below is a shape this app has actually produced: a PostgrestError
// (a plain object, not an Error), the PGRST204 schema-cache trap that fails every
// write until PostgREST reloads, an RLS 42501, a `TypeError: Failed to fetch`
// from an undeployed edge function, and an AbortError from a timed-out capture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KINDS, RETRYABLE_KINDS, classify, isRetryable, Ok, Err, isResult, unwrapOr, isDegraded,
  describeError, describeErrorSync,
} from "../lib/failure.mjs";
import { fmtMetric, NOT_MEASURED } from "../src/utils/formatters.js";
import {
  degradedMessage, sentenceList, sourceLabel, BANNER_ID,
  renderDegradedBanner, ensureDegradedBanner, clearDegradedBanner,
} from "../src/ui/degraded-banner.js";

let n = 0;
const eq = (a, b, msg) => { assert.equal(a, b, msg); n += 1; };
const ok = (c, msg) => { assert.ok(c, msg); n += 1; };

// --- classify: the closed set -------------------------------------------------

eq(classify(null), "ok", "no error is ok");
eq(classify(undefined), "ok");

// A PostgrestError is a PLAIN OBJECT with code/details/hint - not an Error, so
// `err instanceof Error` checks miss it entirely.
eq(
  classify({ code: "PGRST204", message: "Could not find the 'flow_type' column of 'ledger_entries' in the schema cache", details: null, hint: null }),
  "schema",
  "PGRST204 is the schema-cache trap, not a transient server error - retrying it forever is the wrong move",
);
eq(classify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }), "empty",
  ".single() finding no rows is an empty read, not a failure");
eq(classify({ code: "PGRST301", message: "JWT expired" }), "unauthorized");
eq(classify({ code: "42501", message: "new row violates row-level security policy for table \"food_logs\"" }), "unauthorized",
  "an RLS refusal is an auth problem, not a server outage");
eq(classify({ code: "23505", message: "duplicate key value violates unique constraint" }), "conflict");
eq(classify({ code: "42703", message: "column ledger_entries.flow_type does not exist" }), "schema");

// HTTP statuses, wherever the client hid them.
eq(classify({ status: 401, message: "Unauthorized" }), "unauthorized");
eq(classify({ status: 403 }), "unauthorized");
eq(classify({ context: { status: 401 } }), "unauthorized", "FunctionsHttpError hides the status on .context");
eq(classify({ status: 500, message: "Internal Server Error" }), "server");
eq(classify({ status: 429 }), "server");
eq(classify({ status: 409 }), "conflict");
eq(classify({ status: 504 }), "server");

// Network-level: the request never reached the server. Chrome, Firefox and
// Safari each word this differently, and supabase-js wraps it again.
eq(classify(new TypeError("Failed to fetch")), "offline", "Chrome's fetch failure");
eq(classify(new TypeError("NetworkError when attempting to fetch resource.")), "offline", "Firefox");
eq(classify(new TypeError("Load failed")), "offline", "Safari");
eq(classify({ name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" }), "offline");

// Abort and timeout are NOT server failures - reporting them as one sends the
// user chasing an outage that is not happening.
{
  const abort = new Error("The operation was aborted.");
  abort.name = "AbortError";
  eq(classify(abort), "timeout");
  const timeout = new Error("signal timed out");
  timeout.name = "TimeoutError";
  eq(classify(timeout), "timeout");
}

// An error we cannot place is "unknown", never "ok". Silently promoting an
// unrecognised failure to success is the exact bug this module exists to stop.
eq(classify({ weird: true }), "unknown");
eq(classify("something blew up"), "unknown");
for (const k of ["ok", "empty", "unauthorized", "offline", "timeout", "server", "schema", "conflict", "unknown"]) {
  ok(KINDS.includes(k), `KINDS is missing ${k}`);
}
eq(KINDS.length, 9, "KINDS is a CLOSED set - adding one means teaching every consumer about it");

// Retryability rides on the kind, so no caller has to re-derive it.
for (const k of RETRYABLE_KINDS) ok(isRetryable(k), `${k} should be retryable`);
for (const k of ["unauthorized", "schema", "conflict", "empty", "ok"]) {
  ok(!isRetryable(k), `${k} must NOT be retried - retrying burns battery and hides the real fix`);
}

// --- Ok / Err / unwrapOr ------------------------------------------------------

{
  const good = Ok([1, 2, 3], { source: "ledger" });
  ok(good.ok);
  eq(good.kind, "ok");
  eq(good.retryable, false);
  eq(good.meta.source, "ledger");
  ok(isResult(good));

  const bad = Err("offline", new TypeError("Failed to fetch"), { source: "ledger" });
  eq(bad.ok, false);
  eq(bad.kind, "offline");
  eq(bad.retryable, true, "offline is worth retrying and the result says so");
  eq(bad.value, undefined, "a failed result carries NO value - there is nothing to accidentally render");
  ok(isResult(bad));

  // Err(err, meta) also works: classify the error rather than naming the kind.
  const inferred = Err({ code: "PGRST204", message: "schema cache" }, { source: "reminders" });
  eq(inferred.kind, "schema");
  eq(inferred.meta.source, "reminders");
  eq(inferred.retryable, false);

  // An Err is never "ok", whatever was passed in.
  eq(Err(null).kind, "unknown");
}

// unwrapOr is the ONLY sanctioned default - tests/no-swallowed-errors.test.mjs
// flags every other shape, so defaulting is greppable.
eq(unwrapOr(Ok(7), 0), 7);
eq(unwrapOr(Err("offline", null), 0), 0);
assert.deepEqual(unwrapOr(Err("server", null), []), []);
n += 1;
eq(unwrapOr(undefined, "fallback"), "fallback");
eq(unwrapOr(5, 0), 5, "a bare value passes through - migrating a call site cannot break it");

// --- isDegraded: which sources are broken, by name ---------------------------

{
  const clean = isDegraded([Ok([], { source: "ledger" }), Ok([], { source: "food_logs" })]);
  eq(clean.degraded, false);
  eq(clean.failing.length, 0, "an EMPTY read is not a degraded read - that distinction is the whole point");

  const broken = isDegraded([
    Err("offline", null, { source: "ledger" }),
    Ok([], { source: "food_logs" }),
    Err("server", null, { source: "reminders" }),
  ]);
  eq(broken.degraded, true);
  assert.deepEqual(broken.failing, ["ledger", "reminders"]);
  n += 1;

  // A { name: result } map works too, and non-results are ignored rather than
  // assumed healthy: this function only reports failures it can actually see.
  const mapped = isDegraded({ ledger: Err("timeout", null), food_logs: Ok([]), notes: "not a result" });
  assert.deepEqual(mapped.failing, ["ledger"]);
  n += 1;
}

// --- describeError: the FunctionsHttpError body ------------------------------
//
// Promoted out of src/pages/diagnostics.js, which was the only surface that
// unwrapped this properly. Everywhere else printed "[object Object]".
{
  const flat = await describeError({ message: "Edge Function returned a non-2xx status code", status: 400, code: "FN400" });
  ok(flat.includes("non-2xx"), "keeps the message");
  ok(flat.includes("code FN400") && flat.includes("http 400"), "keeps code and status");

  const withBody = await describeError({
    message: "Edge Function returned a non-2xx status code",
    context: { status: 400, text: async () => '{"error":"daily cost cap reached"}' },
  });
  ok(withBody.includes("daily cost cap reached"), "the REAL reason lives in the unread Response body");

  // A body that cannot be read must not lose the rest of the detail.
  const consumed = await describeError({
    message: "boom",
    context: { status: 500, text: async () => { throw new Error("body already consumed"); } },
  });
  ok(consumed.includes("boom"));

  const pg = describeErrorSync({ message: "insert failed", code: "PGRST204", details: "column not in cache", hint: "reload schema" });
  ok(pg.includes("PGRST204") && pg.includes("reload schema"), "details and hint survive");
  eq(await describeError(null), "unknown error");
  ok((await describeError({ a: 1 })).includes("\"a\":1"), "an object with no known fields is still serialised, never [object Object]");
}

// --- fmtMetric: a failed tile NEVER renders a number -------------------------
//
// The highest-value line in the phase. "Rs 0 spent today" for a ledger read that
// 401'd and for a genuinely spend-free day are the same pixels, and only one of
// them is true.
{
  const rupees = (v) => `Rs ${v}`;
  eq(fmtMetric(Ok(1250), rupees), "Rs 1250", "a measured value formats normally");
  eq(fmtMetric(Ok(0), rupees), "Rs 0", "a MEASURED zero is a real fact and must still render");
  eq(fmtMetric(Err("unauthorized", null), rupees), NOT_MEASURED, "a failed read renders the placeholder, never a number");
  eq(fmtMetric(Err("offline", null), rupees), NOT_MEASURED);
  eq(fmtMetric(Ok(null), rupees), NOT_MEASURED, "absent inside a successful read is still absent");
  eq(fmtMetric(null, rupees), NOT_MEASURED, "drop-in for the old fmt(): bare null renders the placeholder");
  eq(fmtMetric(undefined, rupees), NOT_MEASURED);
  eq(fmtMetric(NaN, rupees), NOT_MEASURED, "NaN is not a measurement");
  eq(fmtMetric(Infinity, rupees), NOT_MEASURED);
  eq(fmtMetric(42), "42", "no formatter given still works");
  eq(NOT_MEASURED, "-", "plain hyphen: this repo bans em and en dashes everywhere");

  // The formatter is never handed an absent value, so formatters do not each
  // need their own null branch - that duplication is where the 0s crept back in.
  let called = 0;
  fmtMetric(Err("server", null), () => { called += 1; return "SHOULD NOT HAPPEN"; });
  fmtMetric(null, () => { called += 1; return "SHOULD NOT HAPPEN"; });
  eq(called, 0);
}

// --- the banner NAMES what broke ---------------------------------------------
//
// "Something went wrong" is the same disease one level up: it says a failure
// happened but not what is now missing from the screen.
{
  eq(sentenceList(["money"]), "money");
  eq(sentenceList(["money", "reminders"]), "money and reminders");
  eq(sentenceList(["money", "diet", "reminders"]), "money, diet and reminders");
  eq(sourceLabel("ledger"), "money", "DB table names are not what a person calls their spending");
  eq(sourceLabel("food_logs"), "diet");
  eq(sourceLabel("spend_patterns"), "spend patterns", "an unmapped source is de-slugged, never dropped");
  eq(sourceLabel(""), "one source", "an unnamed failing source is still reported");

  const msg = degradedMessage(["ledger", "reminders"]);
  eq(msg, "Money and reminders could not be loaded. Numbers on this page may be incomplete.");
  ok(!/something went wrong/i.test(msg), "the banner must never fall back to the generic sentence");
  eq(degradedMessage([]), "", "nothing failing means no banner text at all");

  const single = degradedMessage(["food_logs"]);
  ok(single.startsWith("Diet could not be loaded"));

  // No em or en dashes anywhere in the wording (repo-wide hard rule).
  // Written as \u escapes on purpose: this repo bans the literal en/em dash
  // characters everywhere, including inside the test that forbids them.
  ok(!/[\u2013\u2014]/.test(msg + single), "no em or en dashes in user-facing copy");
}

// --- structural: the banner is a live region and diagnostics shares the lib ---
{
  const banner = readFileSync("src/ui/degraded-banner.js", "utf8");
  ok(banner.includes('role", "status"') || banner.includes('role="status"'), "banner must be role=status");
  ok(banner.includes('aria-live", "polite"') || banner.includes('aria-live="polite"'), "banner must be an aria-live=polite region");
  ok(banner.includes(`id = BANNER_ID`) || banner.includes(BANNER_ID), "banner element must carry the shared id");
  ok(/prepend\(/.test(banner), "the banner creates and prepends itself, so no HTML page has to be edited to adopt it");
  eq(BANNER_ID, "degradedBanner");

  // diagnostics.js must IMPORT describeError, not keep a second copy that drifts
  // away from the one every other surface uses.
  const diag = readFileSync("src/pages/diagnostics.js", "utf8");
  ok(/import \{[^}]*\bdescribeError\b[^}]*\} from "\.\.\/\.\.\/lib\/failure\.mjs"/.test(diag), "diagnostics imports describeError from lib/failure.mjs");
  // And it is the first real consumer of the banner: a module that is only ever
  // imported by its own test is the same disease this phase exists to end.
  ok(/from "\.\.\/ui\/degraded-banner\.js"/.test(diag), "diagnostics renders the degraded banner");
  ok(/renderDegradedBanner\(/.test(diag), "diagnostics actually calls renderDegradedBanner");
  ok(!/^async function describeError/m.test(diag), "diagnostics no longer keeps its own copy of describeError");
}

// --- the banner as an actual element ------------------------------------------
//
// There is no jsdom in this repo (no bundler, no test runner), so this is a
// deliberately tiny document stub - just enough to prove the module builds a
// real live region, prepends itself when the page has no markup for it, and
// toggles honestly. Asserting only on the source text would leave the one thing
// that matters (does anything appear on screen?) untested, which is the mistake
// this whole phase is about.
{
  const makeEl = (tag, doc) => {
    const el = {
      tagName: tag.toUpperCase(), id: "", className: "", type: "", hidden: false,
      textContent: "", dataset: {}, children: [], ownerDocument: doc, attrs: {},
      listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      append(...kids) { for (const k of kids) { this.children.push(k); if (typeof k === "object" && k.textContent !== undefined) this.textContent += k.textContent; } },
      prepend(...kids) { this.children.unshift(...kids); },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      querySelector() { return null; },
    };
    return el;
  };
  const registry = new Map();
  const doc = {
    createElement(tag) { return makeEl(tag, doc); },
    createTextNode(text) { return { textContent: text, ownerDocument: doc }; },
    getElementById(id) { return registry.get(id) || null; },
    querySelector() { return doc.body; },
  };
  doc.body = makeEl("body", doc);
  const previousDocument = globalThis.document;
  globalThis.document = doc;
  // ensureDegradedBanner registers by id the way a real document would.
  const origCreate = doc.createElement;
  doc.createElement = (tag) => { const el = origCreate(tag); Object.defineProperty(el, "id", { get() { return el._id || ""; }, set(v) { el._id = v; registry.set(v, el); } }); return el; };

  try {
    const el = ensureDegradedBanner();
    eq(el.id, BANNER_ID);
    eq(el.getAttribute("role"), "status");
    eq(el.getAttribute("aria-live"), "polite");
    eq(el.hidden, true, "created hidden, but created EARLY - an aria-live region inserted at the same moment it gets text is often not announced");
    ok(doc.body.children.includes(el), "prepends itself, so no HTML page needs editing to adopt it");
    eq(ensureDegradedBanner(), el, "idempotent - one banner per page, not one per render");

    // Healthy: nothing said.
    renderDegradedBanner([Ok([], { source: "ledger" }), Ok([], { source: "reminders" })]);
    eq(el.hidden, true);
    eq(el.textContent, "");

    // Degraded: names the sources and offers a retry.
    let retried = 0;
    const verdict = renderDegradedBanner(
      [Err("offline", null, { source: "ledger" }), Ok([], { source: "food_logs" }), Err("server", null, { source: "reminders" })],
      { onRetry: () => { retried += 1; } },
    );
    eq(verdict.degraded, true);
    assert.deepEqual(verdict.failing, ["ledger", "reminders"]);
    n += 1;
    eq(el.hidden, false);
    ok(el.textContent.includes("Money and reminders could not be loaded"), `banner text was: ${el.textContent}`);
    ok(el.textContent.includes("Numbers on this page may be incomplete"));
    ok(!el.textContent.includes("food"), "a healthy source is never named as broken");

    const retry = el.children.find((c) => c.tagName === "BUTTON");
    ok(retry, "a degraded banner offers a retry");
    eq(retry.dataset.action, "retry-degraded");
    retry.listeners.click[0]();
    // The handler defers through a microtask so a throwing onRetry is caught and
    // reported in the banner instead of surfacing as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    eq(retried, 1, "the retry button actually calls back");
    eq(retry.textContent, "Retrying...", "the retry button says something - a silent retry reads as a dead button");

    clearDegradedBanner();
    eq(el.hidden, true);
    eq(el.textContent, "");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

// --- the capture page's own two silent surfaces ------------------------------
//
// Same disease, two more places it lived. Verified against the live project on
// 2026-08-08: raw_ingestions has NEVER recorded source_type 'audio' or 'image'
// in its whole history, and the raw-media bucket has held the same 2 objects
// since 2026-06-29 - while the owner was pressing Stop and tapping the shutter.
// Neither path had any on-screen state: voice reported into a collapsed
// <details>, and a media upload had no per-file state at all.
{
  const runner = readFileSync("src/services/agent-runner.js", "utf8");
  const panel = readFileSync("src/ui/capture-panel.js", "utf8");
  const html = readFileSync("index.html", "utf8");

  // A failed upload must carry the REAL reason, unwrapped the same way
  // diagnostics does it - "[object Object]" is what a PostgrestError renders as
  // when it is dropped into a template literal.
  ok(/import \{[^}]*\bdescribeErrorSync\b[^}]*\} from "\.\.\/\.\.\/lib\/failure\.mjs"/.test(runner),
    "agent-runner unwraps upload failures through lib/failure.mjs, not String(err)");
  ok(/error: describeErrorSync\(err\)/.test(runner), "the onMedia failure event carries a described error");

  // A failure that is only thrown is not a failure that is seen: the runner
  // re-throws so the outbox still retries, AND reports the file first.
  const uploadLoop = /for \(const \[index, file\] of files\.entries\(\)\)[\s\S]*?\n  \}/.exec(runner);
  ok(uploadLoop, "the media upload loop is still recognisable");
  ok(/status: "failed"/.test(uploadLoop[0]) && /throw err/.test(uploadLoop[0]),
    "an upload failure is both reported to the UI and re-thrown so the capture retries");
  ok(!/\n\s*continue;\s*\n/.test(uploadLoop[0].replace(/status: "skipped"[\s\S]*?\n/, "")),
    "no file is skipped without being named first");

  // The two live regions exist, start hidden, and sit ABOVE the collapsed
  // AI-activity disclosure that used to swallow all of this.
  for (const id of ["voiceStatus", "captureAttachments"]) {
    ok(new RegExp(`id="${id}"[^>]*aria-live="polite"`).test(html), `#${id} is an aria-live region`);
    ok(new RegExp(`id="${id}"[^>]*hidden`).test(html), `#${id} exists in the markup before it has text, so it can be announced`);
    ok(html.indexOf(`id="${id}"`) < html.indexOf('<details class="capture-meta">'),
      `#${id} must not be inside or below the collapsed AI activity panel`);
  }

  // THE STOP PATH MOVED, AND SHRANK.
  //
  // This used to require finalizeVoice() with a recorder branch and a dictation
  // branch, because Home ran both at once. That co-tenancy is exactly what made
  // Home feel different from Gym, so it is gone: there is one stop, it lives in
  // ui/voice-control.js, and both pages use it. What still has to be true is the
  // thing the owner actually reported - a stop always says something on screen.
  const control = readFileSync("src/ui/voice-control.js", "utf8");
  ok(/async function stop\(\)/.test(control), "voice-control owns the single stop path");
  ok(/Finishing up/.test(control), "stop reports immediately, before the engine has finished");
  ok(/setStatus/.test(control), "voice-control routes every notice to the page's status line");
  ok(/onNotice/.test(control), "and subscribes to the controller's notices, which guarantee a sentence per stop");
  ok(/setVoiceStatus\(/.test(panel), "capture-panel still writes those notices to #voiceStatus");
}

console.log(`failure-surfacing tests passed: ${n} assertions`);
