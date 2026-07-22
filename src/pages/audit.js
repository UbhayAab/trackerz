import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import {
  fetchRawQueryAudit, fetchOpenDuplicatesWithRecords, resolveDuplicateMerge, dismissDuplicate,
} from "../services/supabase-data.js";
import {
  buildAuditEntries, filterAuditEntries, auditTotals,
  renderAuditLog, auditTotalsHtml, ACTION_FILTERS,
} from "../ui/audit-log.js";
import { renderDuplicatesPanel, bindDuplicatesPanel } from "../ui/duplicates-panel.js";
import { mergeDuplicatePair } from "../services/dedupe-scan.js";

let allEntries = [];
let duplicateRows = [];

bootWithAuth(async () => {
  renderNav();
  populateActionFilter();
  bindControls();
  bindDuplicatesPanel(document.getElementById("dupeList"), {
    onMerge: handleMergeDuplicate,
    onDismiss: handleDismissDuplicate,
  });
  await Promise.all([load(), loadDuplicates()]);
});

async function loadDuplicates() {
  const host = document.getElementById("dupeList");
  if (!host) return;
  try {
    duplicateRows = await fetchOpenDuplicatesWithRecords();
    renderDuplicatesPanel(host, duplicateRows);
  } catch (err) {
    host.innerHTML = `<p class="audit-rejected">Failed to load duplicates: ${String(err?.message || err)}</p>`;
  }
}

async function handleMergeDuplicate(id, picked, sides = {}) {
  const row = duplicateRows.find((r) => r.id === id);
  if (!row) return;
  const dropSide = picked === "a" ? "b" : "a";
  const drop = row[dropSide];
  const keep = row[picked];
  if (!drop) { await dismissDuplicate(id); await loadDuplicates(); return; } // nothing left to drop
  const dropTable = dropSide === "a" ? row.record_a_table : row.record_b_table;
  try {
    // Ledger duplicates are MERGED, not deleted: the loser keeps its row and
    // gains merged_into, so the history survives and the merge is reversible.
    // Every spend query filters merged_into, so the money still stops counting
    // twice. Other tables have no merged_into column, so they still delete.
    if (dropTable === "ledger_entries") {
      await mergeDuplicatePair({
        candidateId: id,
        keepId: sides.keepId || keep?.id,
        dropId: sides.dropId || drop.id,
      });
    } else {
      await resolveDuplicateMerge({ candidateId: id, dropTable, dropId: drop.id });
    }
  } catch (err) {
    alert(`Could not merge: ${err?.message || err}`);
  }
  await Promise.all([loadDuplicates(), load()]);
}

async function handleDismissDuplicate(id) {
  try {
    await dismissDuplicate(id);
  } catch (err) {
    alert(`Could not dismiss: ${err?.message || err}`);
  }
  await loadDuplicates();
}

function populateActionFilter() {
  const sel = document.getElementById("auditAction");
  if (!sel) return;
  sel.innerHTML = ACTION_FILTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

function controls() {
  return {
    since: Number(document.getElementById("auditSince")?.value || 7),
    domain: document.getElementById("auditDomain")?.value || "all",
    outcome: document.getElementById("auditOutcome")?.value || "all",
    action: document.getElementById("auditAction")?.value || "all",
    query: document.getElementById("auditSearch")?.value || "",
  };
}

function bindControls() {
  document.getElementById("auditSince")?.addEventListener("change", load);
  document.getElementById("auditRefresh")?.addEventListener("click", load);
  for (const id of ["auditDomain", "auditOutcome", "auditAction"]) {
    document.getElementById(id)?.addEventListener("change", paint);
  }
  let debounce;
  document.getElementById("auditSearch")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(paint, 200);
  });
}

async function load() {
  const host = document.getElementById("auditList");
  if (host) host.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const raw = await fetchRawQueryAudit({ sinceDays: controls().since });
    allEntries = buildAuditEntries(raw);
    paint();
  } catch (err) {
    if (host) host.innerHTML = `<p class="audit-rejected">Failed to load audit log: ${String(err?.message || err)}</p>`;
    const totalsHost = document.getElementById("auditTotals");
    if (totalsHost) totalsHost.innerHTML = "";
  }
}

function paint() {
  const filtered = filterAuditEntries(allEntries, controls());
  const totalsHost = document.getElementById("auditTotals");
  if (totalsHost) totalsHost.innerHTML = auditTotalsHtml(auditTotals(filtered));
  renderAuditLog(document.getElementById("auditList"), filtered);
}
