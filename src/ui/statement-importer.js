import { parseStatementFile, summarizePreview, commitImport } from "../services/statement-import.js";
import { updateState } from "../state/app-state.js";
import { hydrateStateFromSupabase } from "../state/sync.js";

let parsedCache = null;

export function bindStatementImporter() {
  const fileInput = document.getElementById("statementInput");
  const btn = document.getElementById("statementImportBtn");
  const preview = document.getElementById("statementPreview");
  if (!fileInput || !btn || !preview) return;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    preview.innerHTML = `<p class="muted small">Parsing ${file.name}...</p>`;
    btn.disabled = true;
    try {
      parsedCache = await parseStatementFile(file);
      const summary = summarizePreview(parsedCache);
      renderPreview(preview, parsedCache, summary);
      btn.disabled = false;
      btn.textContent = `Import ${summary.totalRows} row(s)`;
    } catch (err) {
      parsedCache = null;
      preview.innerHTML = `<p class="agent-detail">Parse error: ${err.message || err}</p>`;
    }
  });

  btn.addEventListener("click", async () => {
    if (!parsedCache) return;
    btn.disabled = true;
    btn.textContent = "Importing...";
    try {
      const result = await commitImport(parsedCache);
      preview.innerHTML = `<p class="muted small">Imported ${result.rows} row(s). Refreshing...</p>`;
      parsedCache = null;
      updateState((state) => {
        state.parseLog.unshift(`Statement imported: ${result.rows} row(s).`);
      });
      await hydrateStateFromSupabase();
      btn.textContent = "Imported";
    } catch (err) {
      preview.innerHTML = `<p class="agent-detail">Import error: ${err.message || err}</p>`;
      btn.disabled = false;
      btn.textContent = "Retry import";
    }
  });
}

function renderPreview(host, parsed, summary) {
  const samples = parsed.rows.slice(0, 5);
  const cols = ["date", "description", "debit", "credit"];
  const headerRow = cols.map((c) => `<th>${c}</th>`).join("");
  const sampleRows = samples
    .map((r) => {
      const cells = cols
        .map((c) => `<td>${escape(String(r[parsed.mapping[c]] ?? ""))}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  host.innerHTML = `
    <p class="muted small">${summary.totalRows} rows • debit Rs ${INR(summary.debitTotal)} • credit Rs ${INR(summary.creditTotal)} • ${summary.datedRows} dated</p>
    <p class="muted small">Detected columns: date=<b>${parsed.mapping.date || "?"}</b> desc=<b>${parsed.mapping.description || "?"}</b> debit=<b>${parsed.mapping.debit || "?"}</b> credit=<b>${parsed.mapping.credit || "?"}</b></p>
    <table class="data-table"><thead><tr>${headerRow}</tr></thead><tbody>${sampleRows}</tbody></table>
  `;
}

function escape(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function INR(n) {
  return new Intl.NumberFormat("en-IN").format(n);
}
