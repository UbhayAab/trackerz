// NOTES & MEMORY READER.
//
// Why this file exists: the owner asked "where are my personal notes being
// saved?" and could not answer it from the app. The answer was `public.notes`
// and `public.memory_facts`, and neither had a reader.
//
//   - `notes` had ONE surface: the Home additions feed, which renders a note as
//     `String(n.body).slice(0, 60)` on a single ellipsised line, mixed in among
//     meals and expenses. His longest note is 300+ characters, so four fifths of
//     it existed only in Postgres. A journal you cannot re-read is not a journal.
//   - `memory_facts` had NO surface at all. src/state/sync.js fetches it and
//     assigns `state.memoryFacts`, and nothing in the app has ever read that
//     property. Four standing facts - the ones replayed into the prompt of every
//     later capture - were invisible to the person they are about.
//
// This module is DOM + shaping only, per the src/ui layering rule. It reads
// `state.notes` / `state.memoryFacts`, which src/state/sync.js already hydrates.
// It fetches nothing.
//
// THE ABSENT-DATA RULE. This codebase has a documented habit of rendering
// missing data as a measured value (a 0 that nothing computed, a `false` that
// means "no target exists" rather than "target missed"). So every section here
// distinguishes four states explicitly and never collapses them:
//   loading  - the property is undefined; sync has not run yet.
//   failed   - the read errored; the list is unknown, NOT empty.
//   empty    - the read succeeded and there is genuinely nothing.
//   ready    - rows.
// "0 notes" is only ever printed in the `empty` case.

import { normalizeSource, trustOf, SOURCES } from "../../lib/provenance.mjs";

const PANEL_ID = "notesPanel";
const HOST_ID = "notesPanelHost";
const STYLE_ID = "notesPanelStyles";

// The additions feed truncates a note to this many characters. Anything longer
// is text the owner has never been shown.
export const FEED_LABEL_CHARS = 60;

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function noteKindLabel(kind) {
  switch (String(kind || "note")) {
    case "aspiration": return "Aspiration";
    case "todo": return "To do";
    case "idea": return "Idea";
    default: return "Note";
  }
}

/**
 * What a `memory_facts.provenance` value means for the owner, in his words.
 *
 * The column is a closed set (see supabase/migrations/20260806000060). NULL is
 * deliberate for rows written before the column existed and must read as "from
 * before this was tracked", never as a measured "unknown source" - that would be
 * the same absent-as-measured failure one layer down.
 */
export function provenanceLabel(provenance) {
  if (provenance == null) {
    return { trust: "untracked", label: "saved before origins were tracked", tone: "neutral" };
  }
  const source = normalizeSource(provenance);
  const trust = trustOf(source);
  const note = SOURCES[source]?.note || "";
  if (source === "unknown") {
    return { trust, label: "arrived with no attribution", tone: "warn" };
  }
  if (trust === "owner") {
    return { trust, label: `you said it (${source})`, tone: "ok" };
  }
  if (trust === "derived") {
    return { trust, label: "derived from an earlier capture", tone: "neutral" };
  }
  return { trust, label: `not from you - ${note || source}`, tone: "warn" };
}

function dateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function sectionState(rows, failedReads, needle) {
  const failures = Array.isArray(failedReads) ? failedReads : [];
  const hit = failures.find((f) => String(f).toLowerCase().startsWith(`${needle}:`));
  if (hit) return { state: "failed", reason: String(hit) };
  if (rows === undefined || rows === null) return { state: "loading" };
  if (!Array.isArray(rows)) return { state: "loading" };
  if (!rows.length) return { state: "empty" };
  return { state: "ready" };
}

/**
 * Shape the two stores into one view model. Pure - unit-tested in
 * tests/notes-memory.test.mjs.
 *
 * @param {{notes?: any[], memoryFacts?: any[], failedReads?: string[]}} input
 */
export function buildNotesView({ notes, memoryFacts, failedReads } = {}) {
  const noteState = sectionState(notes, failedReads, "notes");
  const factState = sectionState(memoryFacts, failedReads, "memory");

  const noteRows = (noteState.state === "ready" ? notes : []).map((n) => {
    const body = String(n?.body ?? "");
    return {
      id: n?.id,
      kind: String(n?.kind || "note"),
      kindLabel: noteKindLabel(n?.kind),
      domain: String(n?.domain || "general"),
      status: String(n?.status || "open"),
      body,
      // The whole point of this panel: how much of the note the feed hides.
      hiddenChars: Math.max(0, body.length - FEED_LABEL_CHARS),
      dueOn: n?.due_on || null,
      when: n?.occurred_at || n?.created_at || null,
      whenLabel: dateLabel(n?.occurred_at || n?.created_at),
    };
  }).sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));

  const factRows = (factState.state === "ready" ? memoryFacts : []).map((f) => {
    const prov = provenanceLabel(f?.provenance);
    return {
      id: f?.id,
      key: String(f?.key || ""),
      value: String(f?.value ?? ""),
      kind: String(f?.kind || "fact"),
      confidence: f?.confidence == null ? null : Number(f.confidence),
      provenance: f?.provenance ?? null,
      provenanceLabel: prov.label,
      provenanceTone: prov.tone,
      updatedLabel: dateLabel(f?.updated_at),
    };
  });

  return {
    notes: { ...noteState, rows: noteRows },
    facts: { ...factState, rows: factRows },
    // Badge text. Counts are printed only when the read actually succeeded.
    badge: badgeText(noteState, noteRows.length, factState, factRows.length),
    truncatedInFeed: noteRows.filter((n) => n.hiddenChars > 0).length,
  };
}

function badgeText(noteState, noteCount, factState, factCount) {
  const parts = [];
  if (noteState.state === "ready" || noteState.state === "empty") {
    parts.push(`${noteCount} ${noteCount === 1 ? "note" : "notes"}`);
  } else if (noteState.state === "failed") {
    parts.push("notes unavailable");
  }
  if (factState.state === "ready" || factState.state === "empty") {
    parts.push(`${factCount} ${factCount === 1 ? "fact" : "facts"}`);
  } else if (factState.state === "failed") {
    parts.push("memory unavailable");
  }
  return parts.join(" · ") || "loading";
}

// ---- DOM -------------------------------------------------------------------

const STYLES = `
.notes-panel { display: grid; gap: 10px; }
.notes-panel .np-empty { color: var(--muted); font-size: 0.85rem; margin: 0; }
.notes-panel .np-fail { color: #b4472f; font-size: 0.85rem; margin: 0; }
.notes-panel .np-sub { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
  opacity: 0.6; margin: 8px 0 2px; }
.notes-panel .np-note { border: 1px solid var(--line-strong); border-radius: 10px; padding: 10px 12px;
  background: var(--panel-2); }
.notes-panel .np-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline;
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; }
.notes-panel .np-body { margin: 6px 0 0; font-size: 0.9rem; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.notes-panel .np-meta { margin: 6px 0 0; font-size: 0.72rem; opacity: 0.6; }
.notes-panel .np-fact { display: grid; gap: 2px; border: 1px solid var(--line);
  border-radius: 10px; padding: 8px 12px; }
.notes-panel .np-fact-key { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
.notes-panel .np-fact-value { font-size: 0.9rem; line-height: 1.45; overflow-wrap: anywhere; }
.notes-panel .np-prov { font-size: 0.72rem; opacity: 0.7; }
.notes-panel .np-prov.tone-warn { color: #b4472f; opacity: 1; }
.notes-panel .np-foot { margin: 10px 0 0; font-size: 0.72rem; opacity: 0.55; line-height: 1.45; }
`;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/**
 * Give the panel a home.
 *
 * If the page already ships `#notesPanel` markup we use it. Otherwise we build
 * the whole `<article class="command-panel">` next to the additions feed and
 * insert it there. Doing it here rather than in the page HTML means Home gets a
 * notes reader without editing index.html or src/pages/capture.js, which other
 * work owns - and any page that wants the panel adopts it with an import.
 */
export function mountNotesPanel() {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(PANEL_ID);
  if (existing) { ensureStyles(); return existing; }
  const feed = document.getElementById("additionsFeed");
  if (!feed) return null;
  const anchor = feed.closest("article") || feed;
  const host = document.createElement("article");
  host.className = "command-panel";
  host.id = HOST_ID;
  host.setAttribute("aria-labelledby", "notes-panel-title");
  host.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Saved for you</p>
        <h2 id="notes-panel-title">Notes &amp; memory</h2>
      </div>
      <div class="panel-title-actions">
        <span id="notesPanelBadge" class="metric-badge">loading</span>
      </div>
    </div>
    <div id="${PANEL_ID}" class="notes-panel"></div>`;
  anchor.insertAdjacentElement("afterend", host);
  ensureStyles();
  return document.getElementById(PANEL_ID);
}

function notesSectionHtml(section, truncatedInFeed) {
  if (section.state === "loading") return `<p class="np-empty">Loading your notes...</p>`;
  if (section.state === "failed") {
    return `<p class="np-fail">Couldn't load your notes (${esc(section.reason)}). This is a failed read, not an empty list - your notes are still saved.</p>`;
  }
  if (section.state === "empty") {
    return `<p class="np-empty">No notes saved yet. Anything you capture that is a plan, an intention or a reminder rather than a logged event lands here.</p>`;
  }
  const head = truncatedInFeed
    ? `<p class="np-meta">${truncatedInFeed} of these ${truncatedInFeed === 1 ? "is" : "are"} cut off in the feed above - the full text is here.</p>`
    : "";
  return head + section.rows.map((n) => `
    <div class="np-note" data-note-id="${esc(n.id)}">
      <div class="np-head">
        <span>${esc(n.kindLabel)}</span>
        <span>${esc(n.domain)}</span>
        <span>${esc(n.whenLabel)}</span>
        ${n.status !== "open" ? `<span>${esc(n.status)}</span>` : ""}
        ${n.dueOn ? `<span>due ${esc(n.dueOn)}</span>` : ""}
      </div>
      <p class="np-body">${esc(n.body)}</p>
    </div>`).join("");
}

function factsSectionHtml(section) {
  if (section.state === "loading") return `<p class="np-empty">Loading what the app remembers...</p>`;
  if (section.state === "failed") {
    return `<p class="np-fail">Couldn't load your saved facts (${esc(section.reason)}). Unknown, not empty.</p>`;
  }
  if (section.state === "empty") {
    return `<p class="np-empty">Nothing saved as a standing fact yet.</p>`;
  }
  return section.rows.map((f) => `
    <div class="np-fact" data-fact-id="${esc(f.id)}">
      <span class="np-fact-key">${esc(f.key.replace(/[_-]+/g, " "))} · ${esc(f.kind)}</span>
      <span class="np-fact-value">${esc(f.value)}</span>
      <span class="np-prov tone-${esc(f.provenanceTone)}">${esc(f.provenanceLabel)}${f.updatedLabel ? ` · ${esc(f.updatedLabel)}` : ""}</span>
    </div>`).join("");
}

export function renderNotesPanel(state = {}) {
  const el = mountNotesPanel();
  if (!el) return;
  const view = buildNotesView({
    notes: state.notes,
    memoryFacts: state.memoryFacts,
    failedReads: state.syncFailedReads,
  });
  const badge = document.getElementById("notesPanelBadge");
  if (badge) badge.textContent = view.badge;
  el.innerHTML = `
    ${notesSectionHtml(view.notes, view.truncatedInFeed)}
    <p class="np-sub">What the app remembers about you</p>
    ${factsSectionHtml(view.facts)}
    <p class="np-foot">Notes live in the <code>notes</code> table, standing facts in <code>memory_facts</code>. Both are yours and never leave your account. Archived notes are not shown here. Delete any note with the &#10005; on its row in the feed above.</p>`;
}
