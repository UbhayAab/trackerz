// Gym insights panel - renders lib/gym-insights.mjs into cards + inline,
// theme-aware SVG charts. DOM only, no data logic. Deliberately SEPARATE from
// workout-panel.js (owned elsewhere). Every card degrades to an honest empty
// state; nothing here draws a number the engine did not derive from real rows.

import { computeGymInsights } from "../../lib/gym-insights.mjs";

const PANEL_ID = "gymInsights";

export function renderGymInsights(state = {}) {
  const host = document.getElementById(PANEL_ID);
  if (!host) return;

  let data;
  try {
    data = computeGymInsights({
      workoutLogs: state.workoutLogs || [],
      bodyMetrics: state.bodyMetrics || [],
      budgets: state.budgets || [],
      now: new Date(),
    });
  } catch (err) {
    // A failed computation must look different from an empty dataset.
    host.innerHTML = `
      <div class="panel-title-row"><div><p class="eyebrow">Training</p><h2>Gym intelligence</h2></div></div>
      <p class="gi-error">Could not build gym insights: ${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
    return;
  }

  host.innerHTML = `
    <div class="panel-title-row">
      <div><p class="eyebrow">Training</p><h2>Gym intelligence</h2></div>
      ${consistencyPill(data.consistency)}
    </div>
    <div class="gi-grid">
      ${consistencyCard(data.consistency)}
      ${progressionCard(data.progression)}
      ${bodyweightCard(data.bodyweight)}
      ${muscleCard(data.muscleBalance)}
      ${restCard(data.restPattern)}
    </div>`;
}

// --- consistency ------------------------------------------------------------

function consistencyPill(c) {
  if (!c.hasData) return `<span class="status-pill muted">no sessions yet</span>`;
  const cls = c.metThisWeek ? "gi-pill-good" : "muted";
  return `<span class="status-pill ${cls}">${c.doneThisWeek}/${c.target} this week</span>`;
}

function consistencyCard(c) {
  if (!c.hasData) {
    return card(
      "Weekly consistency",
      `<p class="gi-empty">No workouts logged yet. Log a session on the Gym page and your weekly rhythm shows up here.</p>`
    );
  }
  const streak = c.streakWeeks > 0
    ? `<strong>${c.streakWeeks}</strong> week${c.streakWeeks === 1 ? "" : "s"} active streak`
    : `no active streak`;
  const rate = c.last14Rate != null ? `${c.last14Rate}% of target hit over 14 days` : "";
  return card(
    "Weekly consistency",
    `
      <div class="gi-stat-row">
        <div class="gi-stat"><span class="gi-num">${c.doneThisWeek}<span class="gi-den">/${c.target}</span></span><span class="gi-lbl">this week</span></div>
        <div class="gi-stat"><span class="gi-num">${c.last14Days}</span><span class="gi-lbl">days in 14</span></div>
        <div class="gi-stat"><span class="gi-num">${c.streakWeeks}</span><span class="gi-lbl">week streak</span></div>
      </div>
      ${consistencyBars(c)}
      <p class="gi-note">${streak}${rate ? " · " + rate : ""}</p>
    `
  );
}

// 8-week done-days bar chart, inline SVG, theme-aware (currentColor + accent).
function consistencyBars(c) {
  const weeks = c.weeks || [];
  if (!weeks.length) return "";
  const W = 300, H = 96, padB = 18, padT = 6;
  const max = Math.max(c.target || 1, ...weeks.map((w) => w.doneDays), 1);
  const slot = W / weeks.length;
  const barW = Math.max(6, slot * 0.56);
  const plotH = H - padB - padT;
  const targetY = padT + plotH - (Math.min(c.target, max) / max) * plotH;

  const bars = weeks.map((w, i) => {
    const x = i * slot + (slot - barW) / 2;
    const h = w.doneDays > 0 ? Math.max(3, (w.doneDays / max) * plotH) : 0;
    const y = padT + plotH - h;
    const met = w.doneDays >= (c.target || Infinity);
    const fill = w.doneDays === 0 ? "var(--line-strong)" : met ? "var(--accent)" : "var(--accent-soft)";
    const stroke = w.doneDays > 0 && !met ? "var(--accent)" : "none";
    const label = w.isCurrent ? "now" : (i % 2 === 0 ? w.label.split(" ")[1] : "");
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"
        fill="${fill}" ${stroke !== "none" ? `stroke="${stroke}" stroke-width="1"` : ""}></rect>
      ${w.doneDays > 0 ? `<text class="gi-bar-val" x="${(x + barW / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}">${w.doneDays}</text>` : ""}
      <text class="gi-bar-x" x="${(x + barW / 2).toFixed(1)}" y="${H - 5}">${label}</text>`;
  }).join("");

  return `
    <svg class="gi-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Workouts per week, last 8 weeks">
      <line class="gi-target" x1="0" y1="${targetY.toFixed(1)}" x2="${W}" y2="${targetY.toFixed(1)}"></line>
      ${bars}
    </svg>
    <p class="gi-caption">Distinct workout days per week (last 8). Dashed line = your ${c.target}/week target.</p>`;
}

// --- progression ------------------------------------------------------------

function progressionCard(p) {
  if (!p.hasSets) {
    return card(
      "Progression",
      `<p class="gi-empty">${escapeHtml(p.message)}</p>`,
      "gi-honest"
    );
  }
  const rows = p.exercises.slice(0, 6).map((e) => {
    const arrow = e.trend === "up" ? "↑" : e.trend === "down" ? "↓" : e.trend === "stall" ? "→" : "·";
    const cls = e.trend === "up" ? "gi-up" : e.trend === "down" ? "gi-down" : "gi-flat";
    const flag = e.trend === "up" ? "improving" : e.trend === "stall" ? "stalled" : e.trend === "down" ? "dropped" : "1 session";
    return `
      <li class="gi-prog-row">
        <span class="gi-prog-ex">${escapeHtml(e.exercise)}</span>
        <span class="gi-prog-top">${fmt(e.top)} kg</span>
        <span class="gi-prog-trend ${cls}">${arrow} ${flag}</span>
      </li>`;
  }).join("");
  return card("Progression", `<ul class="gi-prog">${rows}</ul><p class="gi-caption">Top logged weight per exercise, oldest to newest session.</p>`);
}

// --- bodyweight -------------------------------------------------------------

function bodyweightCard(b) {
  if (!b.hasData) {
    const latest = b.latest != null ? `<p class="gi-note">Latest: <strong>${fmt(b.latest)} kg</strong></p>` : "";
    return card("Bodyweight", `${latest}<p class="gi-empty">${escapeHtml(b.message)}</p>`);
  }
  const dirCls = b.direction === "down" ? "gi-down" : b.direction === "up" ? "gi-up" : "gi-flat";
  const sign = b.delta > 0 ? "+" : "";
  return card(
    "Bodyweight",
    `
      <div class="gi-stat-row">
        <div class="gi-stat"><span class="gi-num">${fmt(b.latest)}<span class="gi-den"> kg</span></span><span class="gi-lbl">latest</span></div>
        <div class="gi-stat"><span class="gi-num ${dirCls}">${sign}${fmt(b.delta)}</span><span class="gi-lbl">since first</span></div>
      </div>
      ${bodyweightLine(b.points)}
    `
  );
}

function bodyweightLine(points) {
  if (!points || points.length < 2) return "";
  const W = 300, H = 72, pad = 6;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = (W - pad * 2) / (points.length - 1);
  const y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2);
  const pts = points.map((p, i) => `${(pad + i * stepX).toFixed(1)},${y(p.value).toFixed(1)}`);
  const area = `${pts.join(" ")} ${(pad + (points.length - 1) * stepX).toFixed(1)},${H - pad} ${pad},${H - pad}`;
  const dots = points.map((p, i) => `<circle cx="${(pad + i * stepX).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.4" fill="var(--accent)"></circle>`).join("");
  return `
    <svg class="gi-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Bodyweight trend">
      <polygon class="gi-area" points="${area}"></polygon>
      <polyline class="gi-line" fill="none" points="${pts.join(" ")}"></polyline>
      ${dots}
    </svg>
    <p class="gi-caption">${points.length} weigh-ins.</p>`;
}

// --- muscle balance ---------------------------------------------------------

function muscleCard(m) {
  if (!m.hasData) {
    return card("Muscle balance", `<p class="gi-empty">${escapeHtml(m.message)}</p>`);
  }
  const total = m.groups.reduce((s, g) => s + g.sets, 0) || 1;
  const rows = m.groups.map((g) => {
    const pct = Math.round((g.sets / total) * 100);
    return `
      <li class="gi-mb-row">
        <span class="gi-mb-name">${escapeHtml(g.muscle)}</span>
        <span class="gi-mb-bar"><span class="gi-mb-fill" style="width:${pct}%"></span></span>
        <span class="gi-mb-val">${g.sets}</span>
      </li>`;
  }).join("");
  return card("Muscle balance", `<ul class="gi-mb">${rows}</ul><p class="gi-caption">Logged sets per muscle group.</p>`);
}

// --- rest / skip ------------------------------------------------------------

function restCard(r) {
  if (!r.hasData) {
    return card("Rest & skips", `<p class="gi-empty">${escapeHtml(r.message)}</p>`);
  }
  return card(
    "Rest & skips",
    `
      <div class="gi-stat-row">
        <div class="gi-stat"><span class="gi-num gi-up">${r.doneDays}</span><span class="gi-lbl">trained</span></div>
        <div class="gi-stat"><span class="gi-num gi-down">${r.skippedDays}</span><span class="gi-lbl">skipped</span></div>
        <div class="gi-stat"><span class="gi-num gi-flat">${r.restDays}</span><span class="gi-lbl">rest</span></div>
      </div>
      <p class="gi-caption">Distinct days over the last ${r.windowDays}.</p>
    `
  );
}

// --- shared -----------------------------------------------------------------

function card(title, body, extraCls = "") {
  return `<article class="gi-card ${extraCls}"><h3 class="gi-card-title">${title}</h3>${body}</article>`;
}

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "-";
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export default { renderGymInsights };
