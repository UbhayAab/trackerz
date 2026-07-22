import { parseStatementFile, summarizePreview, importAndPromote, promoteAllStatementRows } from "../services/statement-import.js";
import { PROMOTION_BLOCKERS } from "../imports/row-normalizer.js";
import { updateState } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { showToast } from "./toast.js";

let parsedCache = null;

export function bindStatementImporter() {
  const importer = document.getElementById("importer");
  const fileInput = document.getElementById("statementInput");
  const dropzone = document.getElementById("dropzone");
  const fileLabel = document.getElementById("dropzoneFile");
  const preview = document.getElementById("statementPreview");
  const footer = document.getElementById("importFooter");
  const importBtn = document.getElementById("statementImportBtn");
  const clearBtn = document.getElementById("statementClearBtn");
  if (!importer || !fileInput || !preview || !importBtn) return;

  const setState = (s) => { importer.dataset.state = s; };

  function reset() {
    parsedCache = null;
    fileInput.value = "";
    if (fileLabel) { fileLabel.hidden = true; fileLabel.textContent = ""; }
    preview.hidden = true; preview.innerHTML = "";
    if (footer) footer.hidden = true;
    importBtn.disabled = true; importBtn.textContent = "Import";
    setState("idle");
  }

  async function handleFile(file) {
    if (!file) return;
    setState("parsing");
    if (fileLabel) { fileLabel.hidden = false; fileLabel.textContent = file.name; }
    if (footer) footer.hidden = false;
    preview.hidden = false;
    preview.innerHTML = `<p class="import-foot-note">Reading ${escapeHtml(file.name)}…</p>`;
    importBtn.disabled = true;
    try {
      parsedCache = await parseStatementFile(file);
      const summary = summarizePreview(parsedCache);
      renderPreview(preview, parsedCache, summary);
      setState("parsed");
      importBtn.disabled = false;
      importBtn.textContent = `Import ${summary.totalRows} row${summary.totalRows === 1 ? "" : "s"}`;
    } catch (err) {
      parsedCache = null;
      setState("error");
      preview.innerHTML = `<div class="import-error"><span class="toast-dot"></span>Couldn’t read that file — ${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  fileInput.addEventListener("change", () => handleFile(fileInput.files?.[0]));

  if (dropzone) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ["dragenter", "dragover"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { stop(e); setState("dragover"); dropzone.classList.add("is-dragover"); }));
    ["dragleave", "dragend"].forEach((ev) =>
      dropzone.addEventListener(ev, () => { dropzone.classList.remove("is-dragover"); if (!parsedCache) setState("idle"); }));
    dropzone.addEventListener("drop", (e) => {
      stop(e);
      dropzone.classList.remove("is-dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) { try { fileInput.files = e.dataTransfer.files; } catch { /* read-only in some browsers */ } handleFile(file); }
    });
  }

  clearBtn?.addEventListener("click", reset);

  // Statement rows that predate the promoter are stranded outside every money
  // total. Offer the catch-up run from the same panel rather than leaving that
  // history silently missing.
  preview.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-action='promote-backlog']");
    if (!button) return;
    button.disabled = true;
    button.textContent = "Adding…";
    try {
      const promotion = await promoteAllStatementRows();
      renderResult(preview, { promotion });
      showToast(
        `${promotion.promoted} older row${promotion.promoted === 1 ? "" : "s"} added to your ledger` +
          (promotion.failed.length ? `, ${promotion.failed.length} could not be` : ""),
        { kind: promotion.failed.length ? "error" : "success" },
      );
      await hydrateStateFromSupabase();
    } catch (err) {
      button.disabled = false;
      button.textContent = "Retry";
      showToast(`Could not add older rows — ${err.message || err}`, { kind: "error" });
    }
  });

  importBtn.addEventListener("click", async () => {
    if (!parsedCache) return;
    setState("importing");
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";
    try {
      const result = await importAndPromote(parsedCache);
      const line = summarizeResult(result);
      updateState((state) => { state.parseLog.unshift(`Statement import: ${line}`); });
      // A partial success is reported as a partial success. The counts below the
      // dropzone stay on screen after the toast fades, because "3 rows failed" is
      // the part the user has to act on.
      const failed = result.promotion.failed.length;
      renderResult(preview, result);
      showToast(line, { kind: failed || result.promotion.warnings.length ? "error" : "success" });
      if (fileLabel) fileLabel.hidden = true;
      parsedCache = null;
      fileInput.value = "";
      importBtn.disabled = true;
      importBtn.textContent = "Import";
      setState(failed ? "error" : "parsed");
      await hydrateStateFromSupabase();
    } catch (err) {
      setState("parsed");
      importBtn.disabled = false;
      importBtn.textContent = "Retry import";
      showToast(`Import failed — ${err.message || err}`, { kind: "error" });
    }
  });
}

function renderPreview(host, parsed, summary) {
  const cols = ["date", "description", "debit", "credit"];
  const samples = parsed.rows.slice(0, 5);
  const head = cols.map((c) => `<th>${c}</th>`).join("");
  const body = samples
    .map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(r[parsed.mapping[c]] ?? "—"))}</td>`).join("")}</tr>`)
    .join("");
  const chip = (label, val) =>
    `<span class="map-chip ${val ? "" : "is-missing"}">${label} <b>${val ? escapeHtml(val) : "not found"}</b></span>`;

  host.innerHTML = `
    <div class="import-summary">
      <div class="import-summary-main">
        <span class="import-summary-label">Rows detected</span>
        <strong class="import-summary-value">${summary.totalRows}</strong>
        <span class="import-summary-sub">${summary.datedRows} dated</span>
      </div>
      <div class="import-summary-figures">
        <span class="fig-debit">− Rs ${INR(summary.debitTotal)} <em>debit</em></span>
        <span class="fig-credit">+ Rs ${INR(summary.creditTotal)} <em>credit</em></span>
      </div>
    </div>
    <div class="import-mapping">
      ${chip("Date", parsed.mapping.date)}${chip("Description", parsed.mapping.description)}${chip("Debit", parsed.mapping.debit)}${chip("Credit", parsed.mapping.credit)}
    </div>
    <div class="data-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${blockedNotice(summary)}
    <p class="import-foot-note">First ${samples.length} of ${summary.totalRows} rows. Nothing is saved until you press Import.</p>
  `;
}

// Say up front how many rows the ledger cannot accept. The old preview promised
// "Import 128 rows" and then silently moved zero money.
function blockedNotice(summary) {
  if (!summary.blockedRows) return "";
  const reasons = Object.entries(summary.blockers)
    .map(([code, n]) => `${n} × ${PROMOTION_BLOCKERS[code] || code}`)
    .join(", ");
  return `<div class="import-error"><span class="toast-dot"></span>${summary.promotableRows} of ${summary.totalRows} rows can become ledger entries. ${summary.blockedRows} cannot — ${escapeHtml(reasons)}.</div>`;
}

function summarizeResult({ rowsParsed, rowsAlreadyStored, promotion }) {
  const parts = [`${promotion.promoted} added to your ledger`];
  if (promotion.alreadyPresent) parts.push(`${promotion.alreadyPresent} already there`);
  if (rowsAlreadyStored) parts.push(`${rowsAlreadyStored} already imported`);
  if (promotion.failed.length) parts.push(`${promotion.failed.length} could not be added`);
  return `${rowsParsed} row${rowsParsed === 1 ? "" : "s"} read — ${parts.join(", ")}`;
}

function renderResult(host, result) {
  const { promotion } = result;
  const stat = (label, value, cls) =>
    `<span class="map-chip ${cls}">${label} <b>${value}</b></span>`;
  // Every failure carries its reason. Grouped so 200 undated rows read as one
  // line instead of scrolling the panel away.
  const byReason = new Map();
  for (const f of promotion.failed) {
    const text = PROMOTION_BLOCKERS[f.reason] || f.detail || f.reason;
    byReason.set(text, (byReason.get(text) || 0) + 1);
  }
  const failList = [...byReason.entries()]
    .map(([reason, n]) => `<li>${n} row${n === 1 ? "" : "s"} — ${escapeHtml(reason)}</li>`)
    .join("");
  const warnList = promotion.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");

  host.hidden = false;
  host.innerHTML = `
    <div class="import-mapping">
      ${stat("Added to ledger", promotion.promoted, "")}
      ${stat("Already there", promotion.alreadyPresent, promotion.alreadyPresent ? "" : "is-missing")}
      ${stat("Not added", promotion.failed.length, promotion.failed.length ? "" : "is-missing")}
    </div>
    ${failList ? `<div class="import-error"><span class="toast-dot"></span>Not added to your money totals:<ul>${failList}</ul></div>` : ""}
    ${warnList ? `<div class="import-error"><span class="toast-dot"></span><ul>${warnList}</ul></div>` : ""}
    <p class="import-foot-note">${promotion.promoted} of ${promotion.considered} row${promotion.considered === 1 ? "" : "s"} now count toward your spending.</p>
    ${backlogNotice(promotion.remainingUnpromoted)}
  `;
}

// remainingUnpromoted is null when the count could not be read — say "unknown"
// rather than showing a reassuring 0 nobody measured.
function backlogNotice(remaining) {
  if (remaining == null) return "";
  if (remaining === 0) return "";
  return `<div class="import-error"><span class="toast-dot"></span>${remaining} earlier imported row${remaining === 1 ? " is" : "s are"} still outside your money totals.
    <button class="primary-button" type="button" data-action="promote-backlog">Add them to the ledger</button></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function INR(n) {
  return new Intl.NumberFormat("en-IN").format(n);
}
