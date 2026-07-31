import { analyseStatementFiles, commitAnalysis } from "../services/statement-import.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { updateState } from "../state/app-state.js";
import { showToast } from "./toast.js";

let analysisCache = null;

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
    analysisCache = null;
    fileInput.value = "";
    if (fileLabel) { fileLabel.hidden = true; fileLabel.textContent = ""; }
    preview.hidden = true; preview.innerHTML = "";
    if (footer) footer.hidden = true;
    importBtn.disabled = true; importBtn.textContent = "Import";
    setState("idle");
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setState("parsing");
    if (fileLabel) { fileLabel.hidden = false; fileLabel.textContent = files.map((f) => f.name).join(", "); }
    if (footer) footer.hidden = false;
    preview.hidden = false;
    preview.innerHTML = `<p class="import-foot-note">Reading ${files.length} file${files.length === 1 ? "" : "s"}…</p>`;
    importBtn.disabled = true;
    try {
      analysisCache = await analyseStatementFiles(files);
      renderPreview(preview, analysisCache);
      setState("parsed");
      const n = analysisCache.newRowCount;
      importBtn.disabled = n === 0;
      importBtn.textContent = n === 0 ? "Already imported" : `Import ${n} transaction${n === 1 ? "" : "s"}`;
    } catch (err) {
      analysisCache = null;
      setState("error");
      preview.innerHTML = `<div class="import-error"><span class="toast-dot"></span>${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  if (dropzone) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ["dragenter", "dragover"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { stop(e); setState("dragover"); dropzone.classList.add("is-dragover"); }));
    ["dragleave", "dragend"].forEach((ev) =>
      dropzone.addEventListener(ev, () => { dropzone.classList.remove("is-dragover"); if (!analysisCache) setState("idle"); }));
    dropzone.addEventListener("drop", (e) => {
      stop(e);
      dropzone.classList.remove("is-dragover");
      const files = e.dataTransfer?.files;
      if (files?.length) {
        try { fileInput.files = files; } catch { /* read-only in some browsers */ }
        handleFiles(files);
      }
    });
  }

  clearBtn?.addEventListener("click", reset);

  importBtn.addEventListener("click", async () => {
    if (!analysisCache) return;
    setState("importing");
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";
    try {
      const report = await commitAnalysis(analysisCache);
      const line = summarizeResult(report);
      updateState((state) => { state.parseLog.unshift(`Statement import: ${line}`); });
      renderResult(preview, report, analysisCache);
      showToast(line, { kind: report.warnings.length ? "error" : "success" });
      if (fileLabel) fileLabel.hidden = true;
      analysisCache = null;
      fileInput.value = "";
      importBtn.disabled = true;
      importBtn.textContent = "Import";
      setState(report.warnings.length ? "error" : "parsed");
      await hydrateStateFromSupabase();
    } catch (err) {
      setState("parsed");
      importBtn.disabled = false;
      importBtn.textContent = "Retry import";
      showToast(`Import failed - ${err.message || err}`, { kind: "error" });
    }
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function renderPreview(host, analysis) {
  const t = analysis.totals;
  host.hidden = false;
  host.innerHTML = `
    ${analysis.statements.map(statementCard).join("")}
    ${analysis.rejected.map((r) => `<div class="import-error"><span class="toast-dot"></span>${escapeHtml(r.message)}</div>`).join("")}
    <div class="import-summary">
      <div class="import-summary-main">
        <span class="import-summary-label">Transactions</span>
        <strong class="import-summary-value">${analysis.newRowCount}</strong>
        <span class="import-summary-sub">${analysis.alreadyImported ? `${analysis.alreadyImported} already imported` : "all new"}</span>
      </div>
      <div class="import-summary-figures">
        <span class="fig-debit">− Rs ${INR(t.spending)} <em>actually spent</em></span>
        <span class="fig-credit">+ Rs ${INR(t.income)} <em>actually earned</em></span>
      </div>
    </div>
    ${nonSpendingNote(t)}
    ${flowTable(t)}
    ${reviewList(analysis.review)}
    <p class="import-foot-note">Nothing is saved until you press Import.</p>
  `;
}

// The verification verdict, stated before any number is shown. A statement we
// could not reconcile must not present its totals as if we could.
function statementCard(statement) {
  const tone = statement.audit.confidence === "suspect" ? "is-missing" : "";
  const meta = statement.meta;
  return `
    <div class="import-mapping">
      <span class="map-chip">${escapeHtml(meta.bank || "Unknown bank")} <b>••${escapeHtml(meta.accountLast4 || "????")}</b></span>
      <span class="map-chip">Period <b>${escapeHtml(meta.periodFrom || "?")} → ${escapeHtml(meta.periodTo || "?")}</b></span>
      <span class="map-chip ${tone}">Verified <b>${escapeHtml(statement.audit.confidence)}</b></span>
    </div>
    <p class="import-foot-note">${escapeHtml(statement.audit.summary)}</p>
    ${statement.audit.failures.length
      ? `<div class="import-error"><span class="toast-dot"></span><ul>${statement.audit.failures.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>`
      : ""}
  `;
}

// The single most useful sentence in the whole preview: how much of what left
// the account was not spending at all.
function nonSpendingNote(totals) {
  if (!totals.nonSpendingOutflow) return "";
  const share = Math.round((totals.nonSpendingOutflow / Math.max(totals.grossOut, 1)) * 100);
  return `<p class="import-foot-note">Rs ${INR(totals.grossOut)} left your accounts, but Rs ${INR(totals.nonSpendingOutflow)}
    of that (${share}%) was transfers between your own accounts, investments, credit-card bills and loan principal - not spending.</p>`;
}

function flowTable(totals) {
  const rows = totals.byFlow
    .map((f) => `<tr><td>${escapeHtml(f.label)}</td><td>${f.count}</td>
      <td>${f.out ? `− ${INR(f.out)}` : "-"}</td><td>${f.in ? `+ ${INR(f.in)}` : "-"}</td></tr>`)
    .join("");
  return `<div class="data-table-wrap"><table>
    <thead><tr><th>Kind of movement</th><th>#</th><th>Out</th><th>In</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Questions, biggest stake first. Everything here is something only the user
// can answer - the importer deliberately does not guess these.
function reviewList(review) {
  if (!review.length) return "";
  const items = review.slice(0, 8).map((item) => `<li>${escapeHtml(item.question)}</li>`).join("");
  const more = review.length > 8 ? `<li>and ${review.length - 8} more</li>` : "";
  return `<div class="import-mapping"><span class="map-chip">Needs your eye <b>${review.length}</b></span></div>
    <ul class="import-foot-note">${items}${more}</ul>`;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function summarizeResult(report) {
  const parts = [`${report.inserted} added to your ledger`];
  if (report.alreadyPresent) parts.push(`${report.alreadyPresent} already there`);
  if (report.links) parts.push(`${report.links} linked`);
  if (report.warnings.length) parts.push(`${report.warnings.length} problem${report.warnings.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function renderResult(host, report, analysis) {
  const counts = analysis.analysis.counts;
  const stat = (label, value) => `<span class="map-chip ${value ? "" : "is-missing"}">${label} <b>${value}</b></span>`;
  host.hidden = false;
  host.innerHTML = `
    <div class="import-mapping">
      ${stat("Added", report.inserted)}
      ${stat("Already there", report.alreadyPresent)}
      ${stat("Accounts", report.accounts)}
      ${stat("Transfers paired", counts.transferPairs || 0)}
      ${stat("Refunds matched", counts.refundLinks || 0)}
      ${stat("Recurring found", counts.recurringSeries || 0)}
    </div>
    ${report.warnings.length
      ? `<div class="import-error"><span class="toast-dot"></span><ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
      : ""}
    <p class="import-foot-note">Rs ${INR(analysis.totals.spending)} of real spending now counts toward your totals.</p>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function INR(n) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n || 0);
}
