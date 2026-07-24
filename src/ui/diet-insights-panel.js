// Diet insights + coaching panel. Renders the PURE lib/diet-insights.mjs engine
// as evidence-based cards plus a small 7-day protein-vs-target bar chart
// (inline SVG, theme-aware via CSS vars, honest empty state).
//
// This is a SEPARATE panel from diet-plan-panel.js - it never touches the
// day-nav/plan. It reads state.foodLogs + resolved diet targets and renders
// only what the data supports. Unlogged days are drawn as hollow "no data"
// bars, never as zero-height bars claimed to be measured.

import { computeDietInsights } from "../../lib/diet-insights.mjs";
import { resolveDietTargets } from "../domain/goals.js";

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// A short weekday label (Mon..Sun) for a YYYY-MM-DD key, computed civil-safe.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayLabel(dateKey) {
  const d = new Date(dateKey + "T00:00:00Z");
  return WD[d.getUTCDay()];
}

function card(title, bodyHtml, kicker) {
  return `<article class="di-card">
    ${kicker ? `<p class="di-kicker">${esc(kicker)}</p>` : ""}
    <h3 class="di-card-title">${esc(title)}</h3>
    <div class="di-card-body">${bodyHtml}</div>
  </article>`;
}

// Build the 7-day protein-vs-target bar chart as inline SVG. Bars for logged
// days are filled; unlogged days are a hollow outlined slot with a "no data"
// hatch so the eye reads absence, not a measured zero. The target is a dashed
// reference line labelled with the goal value.
function proteinChart(series, target) {
  const W = 320;
  const H = 150;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = series.length || 1;
  const slot = plotW / n;
  const barW = Math.min(30, slot * 0.6);

  const loggedMax = series.reduce((m, d) => (d.hasData ? Math.max(m, d.protein) : m), 0);
  const scaleMax = Math.max(target * 1.1, loggedMax * 1.1, 60);
  const y = (v) => padT + plotH - (v / scaleMax) * plotH;

  const targetY = y(target);
  const anyData = series.some((d) => d.hasData);

  const bars = series.map((d, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - barW / 2;
    if (!d.hasData) {
      // Hollow "no data" slot - honest absence, not a zero bar.
      const h = 14;
      return `<rect x="${x.toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h}" rx="3"
        class="di-bar-empty" />`;
    }
    const yv = y(d.protein);
    const h = Math.max(2, padT + plotH - yv);
    const met = d.protein >= target;
    return `<rect x="${x.toFixed(1)}" y="${yv.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
      class="di-bar ${met ? "di-bar-met" : "di-bar-short"}" />`;
  }).join("");

  const labels = series.map((d, i) => {
    const cx = padL + slot * i + slot / 2;
    return `<text x="${cx.toFixed(1)}" y="${H - 6}" class="di-axis" text-anchor="middle">${esc(weekdayLabel(d.dateKey))}${d.isToday ? "*" : ""}</text>`;
  }).join("");

  const targetLine = `<line x1="${padL}" y1="${targetY.toFixed(1)}" x2="${W - padR}" y2="${targetY.toFixed(1)}" class="di-target-line" />
    <text x="${W - padR}" y="${(targetY - 4).toFixed(1)}" class="di-axis di-target-label" text-anchor="end">${Math.round(target)}g target</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="di-chart" role="img"
      aria-label="Protein per day over the last 7 days versus the ${Math.round(target)}g target">
      ${anyData ? targetLine : ""}
      ${bars}
      ${labels}
    </svg>
    ${anyData ? "" : `<p class="di-muted di-chart-empty">No food logged in the last 7 days. Log a few meals and your protein chart appears here.</p>`}`;
}

function fmtG(v) {
  return v == null ? "-" : `${Math.round(v)}g`;
}

function proteinCardBody(r) {
  const p = r.protein;
  const rows = [];
  rows.push(`<div class="di-stat-row">
    <span class="di-stat"><span class="di-stat-label">Today</span><strong>${fmtG(p.today)}</strong></span>
    <span class="di-stat"><span class="di-stat-label">${r.daysWithData ? `${r.daysWithData}-day avg` : "Avg"}</span><strong>${fmtG(p.avg)}</strong></span>
    <span class="di-stat"><span class="di-stat-label">Target</span><strong>${fmtG(p.target)}</strong></span>
  </div>`);

  if (p.today == null && p.avg == null) {
    rows.push(`<p class="di-muted">No protein logged yet. Log today's meals to see your gap against the ${Math.round(p.target)}g target.</p>`);
  } else {
    const gap = p.todayGap != null ? p.todayGap : p.avgGap;
    const basis = p.todayGap != null ? "today" : "on your logged days";
    if (gap != null && gap > 0) {
      rows.push(`<p class="di-line di-warn">Short by <strong>${Math.round(gap)}g</strong> ${basis}.</p>`);
    } else if (gap != null) {
      rows.push(`<p class="di-line di-good">Target met ${basis}. Nice.</p>`);
    }
    if (p.consistentlyShort) {
      rows.push(`<p class="di-muted">Every one of your ${r.daysWithData} logged days came in under ${Math.round(p.target)}g - protein is the consistent gap, not a one-off.</p>`);
    } else if (r.thin && r.daysWithData > 0) {
      rows.push(`<p class="di-muted">Only ${r.daysWithData} day${r.daysWithData === 1 ? "" : "s"} logged - log a few more before reading this as a trend.</p>`);
    }
  }
  return rows.join("");
}

function bestSourcesBody(r) {
  if (!r.bestSources.length) {
    return `<p class="di-muted">No protein-bearing foods logged in the last ${r.windowDays} days yet.</p>`;
  }
  const top = r.bestSources.slice(0, 5);
  const items = top.map((s) => {
    const per = s.count > 1 ? ` (~${Math.round(s.perItemProtein)}g each x${s.count})` : ` (~${Math.round(s.perItemProtein)}g)`;
    return `<li><span class="di-source-name">${esc(s.name)}</span><span class="di-source-p">${Math.round(s.totalProtein)}g${per}</span></li>`;
  }).join("");
  return `<ul class="di-source-list">${items}</ul>
    <p class="di-muted di-small">Ranked by total protein from your own logs over ${r.windowDays} days.</p>`;
}

function suggestionBody(r) {
  if (!r.suggestion) {
    if (!r.bestSources.length) {
      return `<p class="di-muted">Log a protein source and a tailored "add X" fix appears here.</p>`;
    }
    return `<p class="di-good">You are at or above target - no fix needed. Keep it up.</p>`;
  }
  return `<p class="di-line">${esc(r.suggestion.text)}</p>
    <p class="di-muted di-small">Drawn from a food you already eat, not generic advice.</p>`;
}

function calorieBody(r) {
  const c = r.calories;
  if (c.today == null && c.avg == null) {
    return `<p class="di-muted">No calories logged in the window. Log meals to track pace against ${Math.round(c.target)} kcal.</p>`;
  }
  const rows = [];
  rows.push(`<div class="di-stat-row">
    <span class="di-stat"><span class="di-stat-label">Today</span><strong>${c.today == null ? "-" : Math.round(c.today)}</strong></span>
    <span class="di-stat"><span class="di-stat-label">Avg</span><strong>${c.avg == null ? "-" : Math.round(c.avg)}</strong></span>
    <span class="di-stat"><span class="di-stat-label">Target</span><strong>${Math.round(c.target)}</strong></span>
  </div>`);
  const delta = c.todayDelta != null ? c.todayDelta : c.avgDelta;
  const basis = c.todayDelta != null ? "today" : "on average";
  if (delta != null) {
    if (delta > 50) rows.push(`<p class="di-line di-warn">Over target by <strong>${Math.round(delta)}</strong> kcal ${basis}.</p>`);
    else if (delta < -50) rows.push(`<p class="di-line">Under target by <strong>${Math.round(-delta)}</strong> kcal ${basis} - fine for fat loss if protein holds.</p>`);
    else rows.push(`<p class="di-line di-good">On target ${basis}.</p>`);
  }
  if (c.trend) {
    const word = c.trend === "up" ? "trending up" : c.trend === "down" ? "trending down" : "flat";
    rows.push(`<p class="di-muted">Week calories are ${word} across your logged days.</p>`);
  } else if (r.thin) {
    rows.push(`<p class="di-muted">Log a few more days for a calorie trend.</p>`);
  }
  return rows.join("");
}

function macroBody(r) {
  const m = r.macro;
  if (!m) {
    return `<p class="di-muted">No macro grams logged yet - can't show a split without protein/carb/fat data.</p>`;
  }
  const seg = (label, pct, cls) => `<div class="di-macro-seg ${cls}" style="width:${pct}%" title="${label} ${pct}%"></div>`;
  const bar = `<div class="di-macro-bar">
    ${seg("Protein", m.proteinPct, "di-mp")}
    ${seg("Carbs", m.carbPct, "di-mc")}
    ${seg("Fat", m.fatPct, "di-mf")}
  </div>`;
  const legend = `<div class="di-macro-legend">
    <span><i class="di-mp"></i>Protein ${m.proteinPct}%</span>
    <span><i class="di-mc"></i>Carbs ${m.carbPct}%</span>
    <span><i class="di-mf"></i>Fat ${m.fatPct}%</span>
  </div>`;
  const note = m.carbHeavy
    ? `<p class="di-line di-warn">Carb-heavy (${m.carbPct}% of calories). Shift some carbs to protein to close the gap.</p>`
    : `<p class="di-muted">Balance looks reasonable across your logged days.</p>`;
  return bar + legend + note;
}

function mealSlotBody(r) {
  const s = r.mealSlots;
  const logged = ["breakfast", "lunch", "snack", "dinner"].filter((slot) => s.counts[slot] > 0);
  const chips = ["breakfast", "lunch", "snack", "dinner"].map((slot) => {
    const on = s.counts[slot] > 0;
    return `<span class="di-slot-chip ${on ? "on" : "off"}">${slot} ${on ? `x${s.counts[slot]}` : "-"}</span>`;
  }).join("");
  let note = "";
  if (!logged.length) {
    note = `<p class="di-muted">No meal slots logged in the window yet.</p>`;
  } else if (s.neverLogged.length) {
    note = `<p class="di-muted">You never logged ${s.neverLogged.join(", ")} in the last ${r.windowDays} days - likely eaten but not captured.</p>`;
  } else {
    note = `<p class="di-good">All four meal slots have at least one log this week.</p>`;
  }
  return `<div class="di-slot-chips">${chips}</div>${note}`;
}

export function renderDietInsights(state) {
  const root = document.querySelector("#dietInsights");
  if (!root) return;

  // A failed load must look different from an empty dataset (never swallowed).
  if (state && state.syncError) {
    root.innerHTML = `<div class="di-head"><p class="eyebrow">Diet coach</p><h2>Protein &amp; macro intelligence</h2></div>
      <p class="di-error">Couldn't load your food logs: ${esc(state.syncError)}. Pull to refresh - these numbers are intentionally blank rather than guessed.</p>`;
    return;
  }

  const foodLogs = (state && Array.isArray(state.foodLogs)) ? state.foodLogs : [];
  const budgets = (state && Array.isArray(state.budgets)) ? state.budgets : [];
  const targets = resolveDietTargets(budgets);

  let r;
  try {
    r = computeDietInsights(foodLogs, targets);
  } catch (err) {
    root.innerHTML = `<div class="di-head"><p class="eyebrow">Diet coach</p><h2>Protein &amp; macro intelligence</h2></div>
      <p class="di-error">Diet insights failed to compute: ${esc(err && err.message)}.</p>`;
    return;
  }

  const proteinTgt = r?.protein?.target != null ? `${Math.round(r.protein.target)}g` : "your target";
  const calorieTgt = r?.calories?.target != null ? `~${Math.round(r.calories.target)} kcal` : "your target";
  const cards = [
    card("Protein gap", proteinCardBody(r), `vs ${proteinTgt} target`),
    card("Close the gap", suggestionBody(r), "concrete fix"),
    card("Your best protein sources", bestSourcesBody(r), "from your logs"),
    card("Calorie pace", calorieBody(r), `vs ${calorieTgt}`),
    card("Macro balance", macroBody(r), "protein / carb / fat"),
    card("Meal logging", mealSlotBody(r), "coverage"),
  ].join("");

  root.innerHTML = `
    <div class="di-head">
      <div>
        <p class="eyebrow">Diet coach</p>
        <h2>Protein &amp; macro intelligence</h2>
      </div>
      <span class="status-pill muted">${r.daysWithData ? `${r.daysWithData}/${r.windowDays} days logged` : "no data yet"}</span>
    </div>
    <div class="di-chart-wrap">
      <div class="di-chart-head"><h3>7-day protein vs target</h3></div>
      ${proteinChart(r.proteinSeries, r.target.protein_g)}
    </div>
    <div class="di-cards">${cards}</div>
  `;
}

export default renderDietInsights;
