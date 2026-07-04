import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";
import { fetchRawQueryAudit } from "../services/supabase-data.js";
import {
  buildAuditEntries, filterAuditEntries, auditTotals,
  renderAuditLog, auditTotalsHtml, ACTION_FILTERS,
} from "../ui/audit-log.js";

let allEntries = [];

bootWithAuth(async () => {
  renderNav();
  populateActionFilter();
  bindControls();
  await load();
});

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
