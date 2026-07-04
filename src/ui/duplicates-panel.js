// Possible-duplicates panel: renders open duplicate_candidates rows (built by
// src/services/dedupe-scan.js) as a pair to compare, with Merge (delete the
// loser) / Dismiss (not a duplicate) actions. The scan + data model existed
// with no UI ever reading them — this is that missing surface.
//
// summarizeSide/pickDefaultKeep are pure (no DOM) so they're unit-tested;
// renderDuplicatesPanel/bindDuplicatesPanel are the only parts that touch DOM.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// One side of a pair -> a short display line. Missing record (e.g. already
// deleted by an earlier merge) is called out rather than rendering "₹undefined".
export function summarizeSide(rec) {
  if (!rec) return "(already removed)";
  const amount = rec.amount != null ? `₹${Number(rec.amount).toLocaleString("en-IN")}` : "₹?";
  const label = rec.merchant || rec.description || "—";
  const when = fmtWhen(rec.occurred_at);
  return `${amount} · ${label}${when ? ` · ${when}` : ""}`;
}

// Which side looks like the more complete/trustworthy record to default to
// keeping: prefer the one with a merchant set, then the longer description,
// then simply the earlier of the two (the first time it was said).
export function pickDefaultKeep(row) {
  const { a, b } = row;
  if (!a || !b) return a ? "a" : "b";
  if (Boolean(a.merchant) !== Boolean(b.merchant)) return a.merchant ? "a" : "b";
  const lenA = (a.description || "").length, lenB = (b.description || "").length;
  if (lenA !== lenB) return lenA > lenB ? "a" : "b";
  return new Date(a.occurred_at) <= new Date(b.occurred_at) ? "a" : "b";
}

function pairCard(row) {
  const keep = pickDefaultKeep(row);
  const side = (rec, key) => `
    <label class="dupe-side${key === keep ? " is-keep" : ""}">
      <input type="radio" name="keep-${row.id}" value="${key}" data-dupe-keep="${row.id}" ${key === keep ? "checked" : ""} />
      <span>${escapeHtml(summarizeSide(rec))}</span>
    </label>`;
  return `<div class="dupe-card" data-dupe-id="${row.id}">
    <div class="dupe-meta">
      <span class="dupe-score">${Math.round(row.score * 100)}% match</span>
      <span class="dupe-reason">${escapeHtml((row.reason || "").split(",").join(" · "))}</span>
    </div>
    <div class="dupe-pair">
      ${side(row.a, "a")}
      ${side(row.b, "b")}
    </div>
    <div class="dupe-actions">
      <button type="button" class="secondary-button" data-dupe-action="dismiss" data-dupe-id="${row.id}">Not a duplicate</button>
      <button type="button" class="primary-button" data-dupe-action="merge" data-dupe-id="${row.id}">Keep selected, delete the other</button>
    </div>
  </div>`;
}

export function renderDuplicatesPanel(el, rows) {
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<p class="muted">No possible duplicates flagged.</p>`;
    return;
  }
  el.innerHTML = rows.map(pairCard).join("");
}

let bound = false;
export function bindDuplicatesPanel(el, { onMerge, onDismiss } = {}) {
  if (bound || !el) return;
  bound = true;
  el.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dupe-action]");
    if (!button) return;
    const id = button.dataset.dupeId;
    if (button.dataset.dupeAction === "dismiss") { onDismiss?.(id); return; }
    const picked = el.querySelector(`input[data-dupe-keep="${id}"]:checked`)?.value || "a";
    onMerge?.(id, picked);
  });
}
