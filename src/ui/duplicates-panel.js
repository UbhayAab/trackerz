// Possible-duplicates panel: renders open duplicate_candidates rows (built by
// src/services/dedupe-scan.js) as a pair to compare, with Merge (stamp the
// loser's merged_into and keep the row) / Dismiss (not a duplicate) actions.
// The scan + data model existed with no UI ever reading them - this is that
// missing surface. Merge never deletes: the losing capture stays visible in the
// audit trail, it just stops counting toward money totals.
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

export function isMerged(rec) {
  return Boolean(rec?.merged_into) || rec?.duplicate_state === "duplicate_loser";
}

// One side of a pair -> a short display line. Missing record (e.g. hard-deleted
// outside the merge flow) is called out rather than rendering "₹undefined", and
// an already-merged row says so instead of looking like live money.
export function summarizeSide(rec) {
  if (!rec) return "(already removed)";
  const amount = rec.amount != null ? `₹${Number(rec.amount).toLocaleString("en-IN")}` : "₹?";
  const label = rec.merchant || rec.description || "-";
  const when = fmtWhen(rec.occurred_at);
  return `${amount} · ${label}${when ? ` · ${when}` : ""}${isMerged(rec) ? " · already merged" : ""}`;
}

// Which side looks like the more complete/trustworthy record to default to
// keeping: prefer the one with a merchant set, then the longer description,
// then simply the earlier of the two (the first time it was said).
export function pickDefaultKeep(row) {
  const { a, b } = row;
  if (!a || !b) return a ? "a" : "b";
  // Never default to keeping a row that was already merged away - it no longer
  // counts anywhere, so making it the survivor would drop both sides.
  if (isMerged(a) !== isMerged(b)) return isMerged(a) ? "b" : "a";
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
  // The record ids ride on the card so the merge handler can name the survivor
  // (merged_into needs an id, not a side letter).
  return `<div class="dupe-card" data-dupe-id="${row.id}" data-rec-a="${escapeHtml(row.a?.id || "")}" data-rec-b="${escapeHtml(row.b?.id || "")}">
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
      <button type="button" class="primary-button" data-dupe-action="merge" data-dupe-id="${row.id}">Keep selected, merge the other into it</button>
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
    const card = button.closest("[data-dupe-id]");
    const keepId = card?.dataset[picked === "a" ? "recA" : "recB"] || null;
    const dropId = card?.dataset[picked === "a" ? "recB" : "recA"] || null;
    onMerge?.(id, picked, { keepId, dropId });
  });
}
