import { parseStatementFile, summarizePreview, commitImport } from "../services/statement-import.js";
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

  importBtn.addEventListener("click", async () => {
    if (!parsedCache) return;
    setState("importing");
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";
    try {
      const result = await commitImport(parsedCache);
      updateState((state) => { state.parseLog.unshift(`Statement imported: ${result.rows} row(s).`); });
      showToast(`Imported ${result.rows} row${result.rows === 1 ? "" : "s"} into your ledger`);
      reset();
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
    <p class="import-foot-note">First ${samples.length} of ${summary.totalRows} rows. Nothing is saved until you press Import.</p>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function INR(n) {
  return new Intl.NumberFormat("en-IN").format(n);
}
