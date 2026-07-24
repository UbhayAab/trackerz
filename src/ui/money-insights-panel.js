// Money intelligence panel - cards + a category breakdown chart.
// DOM-only: it renders whatever buildMoneyInsights (pure) hands back and adds
// no logic of its own. Every figure that could be absent renders "-" or an
// explicit "not enough data" line, never a fabricated 0.

import { buildMoneyInsights } from "../../lib/money-insights.mjs";
import { inr, percent } from "../utils/formatters.js";

const DASH = "-";

// Called on every paint with the live state. `context` lets the page pass a
// read error so a failed ledger read looks different from an empty ledger -
// never render insights off data we could not read.
export function renderMoneyInsights(state, context = {}) {
  const root = document.querySelector("#moneyInsights");
  if (!root) return;

  if (context.loading) {
    root.innerHTML = shell(`<p class="mi-empty">Loading…</p>`);
    return;
  }
  if (context.ledgerError) {
    root.innerHTML = shell(
      `<p class="mi-error">Couldn't read your ledger, so no intelligence can be shown - ${escapeHtml(context.ledgerError)}</p>`
    );
    return;
  }

  const model = buildMoneyInsights({
    ledger: state.ledger || [],
    budgets: state.budgets || [],
    subscriptions: state.subscriptions || [],
    today: new Date(),
  });

  if (model.empty) {
    root.innerHTML = shell(
      `<p class="mi-empty">No spending recorded yet. Import a statement or capture an expense and your spend breakdown, recurring costs and pacing will appear here.</p>`
    );
    return;
  }

  root.innerHTML = shell(`
    <div class="mi-grid">
      ${chartCard(model.breakdown)}
      ${forecastCard(model.forecast)}
      ${recurringCard(model.recurring)}
      ${splitCard(model.split)}
      ${cutCard(model.cut)}
      ${subsCard(model.upcoming)}
    </div>
    <p class="mi-source">Derived from ${model.spendRowCount} expense ${model.spendRowCount === 1 ? "row" : "rows"} (transfers, income and merged duplicates excluded).</p>
  `);
}

function shell(inner) {
  return `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Intelligence</p>
        <h2>Where your money goes</h2>
      </div>
      <span class="status-pill muted">from your ledger</span>
    </div>
    ${inner}
  `;
}

// --- category breakdown chart (inline SVG horizontal bars) --------------------
function chartCard(breakdown) {
  const groups = breakdown.groups || [];
  const body = groups.length
    ? breakdownChart(breakdown)
    : `<p class="mi-empty">No categorised spend yet.</p>`;
  return `
    <article class="mi-card mi-card-wide">
      <h3 class="mi-card-title">Spend by category</h3>
      ${body}
    </article>
  `;
}

function breakdownChart(breakdown) {
  const groups = breakdown.groups;
  const max = Math.max(...groups.map((g) => g.amount), 1);
  const rowH = 44;
  const barY = 22;
  const barH = 10;
  const width = 320;
  const height = groups.length * rowH;

  const rows = groups.map((g, i) => {
    const y = i * rowH;
    const barW = Math.max(2, (g.amount / max) * width);
    const label = escapeHtml(truncate(g.label, 22));
    const value = `${inr(g.amount)} · ${percent(g.pct)}`;
    return `
      <text x="0" y="${y + 13}" class="mi-bar-label">${label}</text>
      <text x="${width}" y="${y + 13}" text-anchor="end" class="mi-bar-value">${escapeHtml(value)}</text>
      <rect x="0" y="${y + barY}" width="${width}" height="${barH}" rx="5" class="mi-bar-track" />
      <rect x="0" y="${y + barY}" width="${barW}" height="${barH}" rx="5" class="mi-bar-fill" />
    `;
  }).join("");

  return `
    <div class="mi-chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
           preserveAspectRatio="xMinYMin meet" role="img"
           aria-label="Spend by category, largest first">
        ${rows}
      </svg>
    </div>
    <p class="mi-total">Total ${inr(breakdown.total)} across ${breakdown.count} ${breakdown.count === 1 ? "expense" : "expenses"}.</p>
  `;
}

// --- month forecast ----------------------------------------------------------
function forecastCard(f) {
  let body;
  if (!f || f.projected == null) {
    body = `<p class="mi-empty">No spend yet this month - nothing to project.</p>`;
  } else if (!f.hasCap) {
    body = `
      <p class="mi-big">${inr(f.projected)}</p>
      <p class="mi-sub">projected month-end at your current pace (${inr(f.spent)} in ${f.dayOfMonth} ${f.dayOfMonth === 1 ? "day" : "days"}).</p>
      <p class="mi-hint">Set a monthly cap to see pacing against a target.</p>
    `;
  } else {
    const cls = f.onTrack ? "mi-good" : "mi-bad";
    const verb = f.onTrack ? "under" : "over";
    const gap = Math.abs(f.projectedVsCap);
    body = `
      <p class="mi-big ${cls}">${inr(f.projected)}</p>
      <p class="mi-sub">projected vs ${inr(f.cap)} cap - <strong class="${cls}">${inr(gap)} ${verb}</strong> (${percent(f.pctOfCapProjected)} of cap).</p>
      <p class="mi-hint">${inr(f.spent)} spent in the first ${f.dayOfMonth} of ${f.daysInMonth} days.</p>
    `;
  }
  return card("Month forecast", body);
}

// --- biggest recurring cost --------------------------------------------------
function recurringCard(r) {
  if (!r) return card("Biggest recurring cost", `<p class="mi-empty">No repeated near-equal charge found yet.</p>`);
  const rate = r.perWeek != null
    ? `about ${r.perWeek}x/week`
    : `${r.count} times over ${r.spanDays} ${r.spanDays === 1 ? "day" : "days"}`;
  const monthly = r.monthlyCost != null
    ? `<p class="mi-sub"><strong>${inr(r.monthlyCost)}/mo</strong>${r.weeklyCost != null ? ` (${inr(r.weeklyCost)}/wk)` : ""} at that rate.</p>`
    : `<p class="mi-sub"><strong>${inr(r.observedTotal)}</strong> so far.</p>`;
  return card("Biggest recurring cost", `
    <p class="mi-big">${escapeHtml(truncate(r.label, 22))}</p>
    <p class="mi-sub">${inr(r.medianAmount)} each, ${rate}.</p>
    ${monthly}
  `);
}

// --- discretionary vs essential ---------------------------------------------
function splitCard(s) {
  if (!s) return card("Discretionary vs essential", `<p class="mi-empty">No spend to split yet.</p>`);
  const ratio = s.discretionaryRatio != null ? percent(s.discretionaryRatio) : DASH;
  const dPct = s.total > 0 ? (s.discretionary / s.total) * 100 : 0;
  const ePct = s.total > 0 ? (s.essential / s.total) * 100 : 0;
  const uPct = Math.max(0, 100 - dPct - ePct);
  const unknownNote = s.unknown > 0
    ? `<p class="mi-hint">${inr(s.unknown)} not tagged either way - excluded from the ratio.</p>`
    : "";
  return card("Discretionary vs essential", `
    <p class="mi-big">${ratio}<span class="mi-unit"> discretionary</span></p>
    <div class="mi-splitbar" role="img" aria-label="Discretionary ${inr(s.discretionary)}, essential ${inr(s.essential)}">
      <span class="mi-seg mi-seg-disc" style="width:${dPct}%"></span>
      <span class="mi-seg mi-seg-ess" style="width:${ePct}%"></span>
      <span class="mi-seg mi-seg-unk" style="width:${uPct}%"></span>
    </div>
    <p class="mi-sub">${inr(s.discretionary)} discretionary · ${inr(s.essential)} essential.</p>
    ${unknownNote}
  `);
}

// --- where to cut ------------------------------------------------------------
function cutCard(c) {
  if (!c) return card("Where you could cut", `<p class="mi-empty">No discretionary spend to trim yet.</p>`);
  const share = c.shareOfDiscretionary != null ? ` (${percent(c.shareOfDiscretionary)} of discretionary)` : "";
  return card("Where you could cut", `
    <p class="mi-sub"><strong>${escapeHtml(truncate(c.label, 22))}</strong> is your biggest discretionary category at ${inr(c.amount)}${share}.</p>
    <p class="mi-hint">Halving it would free up about <strong>${inr(c.halfSaving)}</strong>.</p>
  `);
}

// --- upcoming subscriptions --------------------------------------------------
function subsCard(list) {
  if (!list || !list.length) {
    return card("Upcoming subscriptions", `<p class="mi-empty">Nothing due in the next 30 days.</p>`);
  }
  const items = list.map((s) => {
    const when = s.daysAway <= 0 ? "due now" : `in ${s.daysAway} ${s.daysAway === 1 ? "day" : "days"}`;
    const amt = s.amount != null ? inr(s.amount) : DASH;
    return `<li><span class="mi-sub-merchant">${escapeHtml(truncate(s.merchant, 20))}</span><span class="mi-sub-when">${amt} · ${when}</span></li>`;
  }).join("");
  return card("Upcoming subscriptions", `<ul class="mi-sublist">${items}</ul>`);
}

// --- helpers -----------------------------------------------------------------
function card(title, body) {
  return `<article class="mi-card"><h3 class="mi-card-title">${title}</h3>${body}</article>`;
}

function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
