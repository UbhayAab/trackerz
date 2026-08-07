// IMPORT AND EXPORT A CALENDAR (.ics).
//
// "The calendar must be able to mirror ANY other calendar." Every calendar on
// earth exports .ics and most publish a subscribable .ics URL, so this one
// surface covers Google, Apple, Outlook, Fastmail, Zoho, Proton, a college
// timetable and a cricket fixture list, with no provider API and no OAuth.
//
// THE DISCIPLINE, copied deliberately from src/ui/statement-importer.js:
// the preview the user approves and the rows that get written come from the
// SAME call. `previewFromIcs()` produces one array of reminder rows; the
// preview renders THAT array through `describeRule`, and Add writes THAT array
// through `toInsertRow`. There is no second parse between looking and writing,
// so the preview cannot over-promise. tests/ics.test.mjs asserts the only
// transformation between the two (`toInsertRow`) leaves every rule field alone.
//
// AND EVERY PROBLEM IS ON SCREEN. `problems[]` is rendered in full, not
// summarised and not truncated: an importer that drops four of forty events and
// shows "36 imported" has told the user something false. Errors (nothing was
// imported) and warnings (imported, but lossily) are shown separately so the
// difference is legible.
//
// DOM and event binding only. All the calendar thinking is in lib/ics.mjs,
// which is pure and runs identically in Node under the tests.

import { createReminder } from "../services/supabase-data.js";
import { fetchCalendarReminders } from "../services/jarvis.js";
import {
  icsToReminders, remindersToIcs, toInsertRow, subscriptionPlan,
  icsProxyRequest, icsUrlToHttps, DEFAULT_TZ,
} from "../../lib/ics.mjs";
import { describeRule, ruleProblem } from "../../lib/reminders.mjs";
import { showToast } from "./toast.js";

// Same shape as src/imports/sheet-reader.js: the vendored copy first, a CDN
// only as a rescue for a half-deployed Pages build. A static import here would
// put 78 KB on the critical path of a page that usually never opens this panel.
export const VENDORED_ICAL = "../../vendor/ical.js/ical.js@2.2.1/index.mjs";
const CDN_ICAL = "https://esm.sh/ical.js@2.2.1";

export const HOST_ID = "calendarImport";
const MAX_PREVIEW_ROWS = 8;

let parserPromise = null;

/**
 * Load the iCalendar parser. Named failures only: a parser that could not load
 * must never read as "your calendar was empty".
 */
export async function loadCalendarParser() {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const failures = [];
    for (const specifier of [VENDORED_ICAL, CDN_ICAL]) {
      try {
        const mod = await import(/* @vite-ignore */ specifier);
        const ICAL = mod.default || mod;
        if (ICAL && typeof ICAL.parse === "function" && typeof ICAL.Component === "function") return ICAL;
        failures.push(`${specifier}: loaded but has no parse/Component export`);
      } catch (err) {
        failures.push(`${specifier}: ${err && err.message ? err.message : String(err)}`);
      }
    }
    throw new Error(`Could not load the calendar parser. ${failures.join(" | ")}`);
  })();
  return parserPromise;
}

// ---------------------------------------------------------------------------
// The one function behind both the preview and the write
// ---------------------------------------------------------------------------

/**
 * Everything the preview needs, and the exact rows the write will use.
 *
 * `reminders` is the array that gets inserted. `lines` is that same array read
 * back in English, index for index, so the two cannot describe different rules.
 */
export function previewFromIcs(text, parser, { timezone = DEFAULT_TZ, filename = "" } = {}) {
  const result = icsToReminders(text, { parser, timezone });
  const lines = result.reminders.map((row) => ({
    title: row.title,
    rule: describeRule(row),
    kind: row.kind,
    zone: row.at_time ? row.timezone : null,
    // Belt and braces: if a row that cannot fire ever reached this list, say so
    // here rather than letting it be written and go quiet forever.
    unusable: ruleProblem(row),
    uid: row._source ? row._source.uid : null,
  }));
  return { ...result, lines, filename };
}

/**
 * Write a preview. `create` is injected so the tests can prove that what goes
 * to the database is byte-for-byte what the preview showed.
 *
 * Every failure is collected and reported rather than aborting the batch: 30
 * of 31 reminders imported with one named failure is a better outcome than an
 * error page, and a silent partial import is the worst outcome of the three.
 */
export async function commitPreview(preview, create = createReminder) {
  const report = { added: 0, failed: 0, problems: [], rows: [] };
  for (const item of (preview && preview.reminders) || []) {
    const row = toInsertRow(item);
    report.rows.push(row);
    try {
      await create(row);
      report.added += 1;
    } catch (err) {
      report.failed += 1;
      report.problems.push({
        severity: "error",
        component: "WRITE",
        summary: row.title,
        reason: `"${row.title}" could not be saved: ${err && err.message ? err.message : String(err)}`,
      });
    }
  }
  return report;
}

/**
 * Refresh from a subscribable .ics URL.
 *
 * `fetchIcs` MUST be injected. A browser cannot fetch a foreign .ics: almost no
 * calendar host sends Access-Control-Allow-Origin, so the request fails at the
 * network layer with an opaque error. The fetch belongs in an edge function -
 * see `icsProxyRequest` in lib/ics.mjs for the exact contract, and the note in
 * `defaultFetchIcs` below for what is still missing.
 */
export async function refreshFromIcsUrl(url, {
  fetchIcs = defaultFetchIcs, parser = null, timezone = DEFAULT_TZ, existing = null,
} = {}) {
  const request = icsProxyRequest(url);
  if (request.error) throw new Error(request.error);
  const ICAL = parser || await loadCalendarParser();
  const text = await fetchIcs(request);
  if (typeof text !== "string" || !text.length) {
    throw new Error(`${request.body.url} returned nothing that looks like a calendar`);
  }
  const preview = previewFromIcs(text, ICAL, { timezone, filename: request.body.url });
  const current = existing || await fetchCalendarReminders();
  return { preview, plan: subscriptionPlan({ incoming: preview.reminders, existing: current, sourceUrl: request.body.url }) };
}

// The endpoint this needs does not exist yet - supabase/functions/gcal belongs
// to another agent. Failing with the exact contract in the message is the whole
// point: a subscription that silently never updates is the failure mode this
// app keeps rediscovering.
async function defaultFetchIcs(request) {
  const { getSupabaseClient } = await import("../services/supabase-client.js");
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke(request.endpoint, { body: request.body });
  if (error) {
    throw new Error(
      `Could not fetch ${request.body.url}. The browser cannot request another site's calendar directly (CORS), `
      + `so this goes through the "${request.endpoint}" edge function, which needs to accept `
      + `{ action: "fetch_ics", url } and return { ok, status, text, etag }. Reported: ${error.message || error}`,
    );
  }
  if (data && data.ok === false) throw new Error(data.error || `${request.body.url} could not be fetched`);
  return data && typeof data.text === "string" ? data.text : "";
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Build the .ics for a set of rows, plus whatever it could not express. */
export function buildExport(rows, opts = {}) {
  return remindersToIcs(rows, { calName: "Trackerz reminders", ...opts });
}

/** Hand the file to the browser. Split out so the builder above stays testable. */
export function downloadIcs(ics, filename = "trackerz-calendar.ics") {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("This browser cannot download a file from a script");
  }
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously races the download in
  // Safari and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** A named failure, never a blank panel. */
export function renderError(message) {
  return `<div class="import-error"><span class="toast-dot"></span>${escapeHtml(message)}</div>`;
}

function problemList(problems) {
  if (!problems.length) return "";
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity !== "error");
  const item = (p) => `<li><b>${escapeHtml(p.summary || p.component || "")}</b> ${escapeHtml(p.reason)}</li>`;
  return `
    ${errors.length ? `<div class="import-error"><span class="toast-dot"></span>
      <div><strong>${errors.length} thing${errors.length === 1 ? "" : "s"} could not be imported</strong>
      <ul class="cal-import-problems">${errors.map(item).join("")}</ul></div></div>` : ""}
    ${warnings.length ? `<details class="cal-import-warnings" open>
      <summary>${warnings.length} thing${warnings.length === 1 ? "" : "s"} imported with a change worth knowing</summary>
      <ul class="cal-import-problems">${warnings.map(item).join("")}</ul></details>` : ""}
  `;
}

/**
 * The preview. Every number here is read off the same array the Add button
 * writes, so the two cannot disagree.
 */
export function renderPreview(preview) {
  const n = preview.reminders.length;
  const shown = preview.lines.slice(0, MAX_PREVIEW_ROWS);
  const more = n - shown.length;
  return `
    <div class="import-summary">
      <div class="import-summary-main">
        <span class="import-summary-label">Reminders to add</span>
        <strong class="import-summary-value">${n}</strong>
        <span class="import-summary-sub">from ${preview.stats.vevents} event${preview.stats.vevents === 1 ? "" : "s"}${preview.calendar.name ? ` in ${escapeHtml(preview.calendar.name)}` : ""}</span>
      </div>
      <div class="import-summary-figures">
        <span>${escapeHtml(preview.calendar.prodid || "unknown calendar app")}</span>
        <span>times converted to <b>${escapeHtml(preview.stats.timezone)}</b></span>
      </div>
    </div>
    ${n ? `<ul class="cal-import-rows">${shown.map((line) => `
      <li>
        <span class="cal-import-title">${escapeHtml(line.title)}</span>
        <span class="cal-import-rule">${escapeHtml(line.rule)}</span>
        ${line.unusable ? `<span class="cal-import-bad">${escapeHtml(line.unusable)}</span>` : ""}
      </li>`).join("")}${more > 0 ? `<li class="cal-import-more">and ${more} more</li>` : ""}</ul>`
      : `<p class="import-foot-note">Nothing in this file became a reminder.</p>`}
    ${problemList(preview.problems)}
    <p class="import-foot-note">Nothing is saved until you press Add.</p>
  `;
}

function renderResult(report) {
  const stat = (label, value) => `<span class="map-chip ${value ? "" : "is-missing"}">${label} <b>${value}</b></span>`;
  return `
    <div class="import-mapping">${stat("Added", report.added)}${stat("Failed", report.failed)}</div>
    ${problemList(report.problems)}
  `;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

// The URL row is not decoration. Every OAuth-free way to mirror Google, Apple,
// Outlook or Fastmail goes through a private .ics address, and until 2026-08-08
// `refreshFromIcsUrl` existed, was tested, and had NO control anywhere in the app
// that could call it - so the only way to import a calendar was to export a file
// by hand every time. The edge function's `fetch_ics` action is the other half.
const SHELL = `
  <div class="cal-import" data-state="idle">
    <div class="cal-import-head">
      <h3>Mirror another calendar</h3>
      <p class="import-foot-note">Google, Apple, Outlook, Fastmail - paste the calendar's private .ics address, or drop a file.</p>
    </div>
    <div class="cal-import-url">
      <label class="visually-hidden" for="calIcsUrl">Calendar .ics address</label>
      <input type="url" id="calIcsUrl" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" autocomplete="off" spellcheck="false">
      <button type="button" class="btn-ghost" id="calIcsFetch">Read it</button>
    </div>
    <label class="dropzone" id="calIcsDrop">
      <input type="file" id="calIcsInput" accept=".ics,text/calendar" hidden>
      <span>…or drop an .ics file here, or choose one</span>
      <span class="dropzone-file" id="calIcsFile" hidden></span>
    </label>
    <div class="cal-import-preview" id="calIcsPreview" hidden></div>
    <div class="cal-import-actions">
      <button type="button" class="btn-primary" id="calIcsAdd" disabled>Add</button>
      <button type="button" class="btn-ghost" id="calIcsClear">Clear</button>
      <button type="button" class="btn-ghost" id="calIcsExport">Export my calendar (.ics)</button>
    </div>
  </div>
`;

/**
 * Build the panel inside `host` and wire it up.
 *
 * Dependencies are injectable so the whole flow can be driven without a
 * network: `{ parser, create, fetchRows }`.
 */
export function mountCalendarImport(host, { parser = null, create = createReminder, fetchRows = fetchCalendarReminders } = {}) {
  if (!host) return null;
  host.innerHTML = SHELL;
  const root = host.querySelector(".cal-import");
  const input = host.querySelector("#calIcsInput");
  const drop = host.querySelector("#calIcsDrop");
  const label = host.querySelector("#calIcsFile");
  const preview = host.querySelector("#calIcsPreview");
  const addBtn = host.querySelector("#calIcsAdd");
  const clearBtn = host.querySelector("#calIcsClear");
  const exportBtn = host.querySelector("#calIcsExport");
  const urlInput = host.querySelector("#calIcsUrl");
  const fetchBtn = host.querySelector("#calIcsFetch");

  // THE cached preview. The Add handler writes this object and nothing else.
  let pending = null;
  const setState = (s) => { root.dataset.state = s; };

  function reset() {
    pending = null;
    input.value = "";
    if (urlInput) urlInput.value = "";
    label.hidden = true;
    label.textContent = "";
    preview.hidden = true;
    preview.innerHTML = "";
    addBtn.disabled = true;
    addBtn.textContent = "Add";
    setState("idle");
  }

  async function handleFile(file) {
    if (!file) return;
    setState("parsing");
    label.hidden = false;
    label.textContent = file.name;
    preview.hidden = false;
    preview.innerHTML = `<p class="import-foot-note">Reading ${escapeHtml(file.name)}…</p>`;
    addBtn.disabled = true;
    try {
      const ICAL = parser || await loadCalendarParser();
      const text = await file.text();
      pending = previewFromIcs(text, ICAL, { filename: file.name });
      preview.innerHTML = renderPreview(pending);
      setState(pending.reminders.length ? "parsed" : "empty");
      addBtn.disabled = pending.reminders.length === 0;
      addBtn.textContent = pending.reminders.length
        ? `Add ${pending.reminders.length} reminder${pending.reminders.length === 1 ? "" : "s"}`
        : "Nothing to add";
    } catch (err) {
      pending = null;
      setState("error");
      preview.innerHTML = renderError(err && err.message ? err.message : String(err));
    }
  }

  // Read a subscribable .ics address. Goes through the `fetch_ics` action on the
  // gcal edge function, because a browser cannot fetch a foreign calendar itself
  // (almost no host sends Access-Control-Allow-Origin). Produces the SAME preview
  // object a dropped file does, so Add writes the same rows either way.
  async function handleUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) return;
    setState("parsing");
    preview.hidden = false;
    preview.innerHTML = `<p class="import-foot-note">Reading ${escapeHtml(url)}…</p>`;
    addBtn.disabled = true;
    fetchBtn.disabled = true;
    try {
      const { preview: got } = await refreshFromIcsUrl(url, { parser: parser || await loadCalendarParser() });
      pending = got;
      preview.innerHTML = renderPreview(pending);
      setState(pending.reminders.length ? "parsed" : "empty");
      addBtn.disabled = pending.reminders.length === 0;
      addBtn.textContent = pending.reminders.length
        ? `Add ${pending.reminders.length} reminder${pending.reminders.length === 1 ? "" : "s"}`
        : "Nothing to add";
    } catch (err) {
      pending = null;
      setState("error");
      // The server's own sentence, never a rewritten one: "that host answered
      // 403" and "the link is the HTML view, not the .ics address" are different
      // problems with different fixes, and only the server knows which happened.
      preview.innerHTML = renderError(err && err.message ? err.message : String(err));
    } finally {
      fetchBtn.disabled = false;
    }
  }

  fetchBtn.addEventListener("click", () => handleUrl(urlInput.value));
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleUrl(urlInput.value); }
  });

  input.addEventListener("change", () => handleFile(input.files && input.files[0]));

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => { stop(e); drop.classList.add("is-dragover"); });
  }
  for (const ev of ["dragleave", "dragend"]) {
    drop.addEventListener(ev, () => drop.classList.remove("is-dragover"));
  }
  drop.addEventListener("drop", (e) => {
    stop(e);
    drop.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  clearBtn.addEventListener("click", reset);

  addBtn.addEventListener("click", async () => {
    if (!pending) return;
    setState("writing");
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    const report = await commitPreview(pending, create);
    preview.innerHTML = renderResult(report);
    setState(report.failed ? "error" : "done");
    addBtn.textContent = report.failed ? "Retry the rest" : "Added";
    addBtn.disabled = report.failed === 0;
    if (report.failed) {
      // Only the rows that failed stay pending, so pressing Retry cannot
      // duplicate the ones that were written.
      const failedTitles = new Set(report.problems.map((p) => p.summary));
      pending = { ...pending, reminders: pending.reminders.filter((r) => failedTitles.has(r.title)) };
    } else {
      pending = null;
      input.value = "";
      label.hidden = true;
    }
    showToast(
      report.failed
        ? `${report.added} added, ${report.failed} failed`
        : `${report.added} reminder${report.added === 1 ? "" : "s"} added from your calendar`,
      { kind: report.failed ? "error" : "success" },
    );
  });

  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    try {
      const rows = await fetchRows();
      const built = buildExport(rows);
      if (built.exported === 0) {
        preview.hidden = false;
        preview.innerHTML = renderError(
          built.skipped
            ? `None of your ${built.skipped} reminders could be written to a calendar file. ${built.problems.map((p) => p.reason).join(" ")}`
            : "You have no reminders to export yet.",
        );
        return;
      }
      downloadIcs(built.ics, "trackerz-calendar.ics");
      preview.hidden = false;
      preview.innerHTML = `
        <div class="import-mapping"><span class="map-chip">Exported <b>${built.exported}</b></span>
        ${built.skipped ? `<span class="map-chip is-missing">Left out <b>${built.skipped}</b></span>` : ""}</div>
        ${problemList(built.problems)}`;
      showToast(`Exported ${built.exported} reminder${built.exported === 1 ? "" : "s"}`, { kind: "success" });
    } catch (err) {
      preview.hidden = false;
      preview.innerHTML = renderError(`Export failed: ${err && err.message ? err.message : String(err)}`);
    } finally {
      exportBtn.disabled = false;
    }
  });

  return { reset, handleFile, get pending() { return pending; } };
}

/**
 * Mount into `#calendarImport`, creating that host inside the Settings
 * "Reminders" card when the page does not declare one.
 *
 * Same trade as src/ui/calendar-panel.js: rendering into a section that already
 * exists costs no HTML change, no nav change and no service-worker change. The
 * host is created here rather than in src/pages/settings.js so DOM construction
 * stays in src/ui/ (tests/architecture.test.mjs draws that line).
 */
export function bindCalendarImport(root = null, deps = {}) {
  const scope = root || (typeof document === "undefined" ? null : document);
  if (!scope) return null;
  const find = (id) => (scope.getElementById ? scope.getElementById(id) : scope.querySelector(`#${id}`));
  let host = find(HOST_ID);
  if (!host) {
    const anchor = find("remindersManage");
    if (!anchor || !anchor.parentNode || typeof document === "undefined") return null;
    host = document.createElement("div");
    host.id = HOST_ID;
    anchor.parentNode.insertBefore(host, anchor.nextSibling);
  }
  return mountCalendarImport(host, deps);
}

export { icsUrlToHttps, icsProxyRequest };
