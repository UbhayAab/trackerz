import { getState } from "../state/app-state.js";
import { $, $all } from "../utils/dom.js";
import { dailySeries } from "../analytics/period-aggregator.js";

let currentView = "dod";

export function renderCharts(view = currentView, state = getState()) {
  currentView = view || currentView;
  const data = buildTrendData(state)[currentView];
  // A day with NO rows is not a day with zero. dailySeries now returns null for
  // absent and 0 only for measured-zero, and JavaScript quietly coerces null to
  // 0 in arithmetic - so this used to draw a confident flat bar for a day the
  // user simply had not logged. Over a 30-day window that is a chart telling you
  // your intake collapsed when in fact you were on holiday.
  const measured = data.filter((p) => p.value != null);
  const max = Math.max(1, ...measured.map((point) => point.value));
  $("#activeViewLabel").textContent = currentView.toUpperCase();
  $("#chart").innerHTML = data
    .map((point) => {
      if (point.value == null) {
        // Rendered as an explicit gap, and titled so hovering says which it is.
        return `
        <div class="bar bar-nodata" title="${point.label}: nothing logged">
          <div class="bar-gap" aria-hidden="true"></div>
          <span>${point.label}</span>
        </div>
      `;
      }
      const height = Math.max(8, Math.round((point.value / max) * 142));
      return `
        <div class="bar">
          <div class="bar-fill" style="height:${height}px"></div>
          <span>${point.label}</span>
        </div>
      `;
    })
    .join("");
}

export function bindViewTabs() {
  $all(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $all(".tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      renderCharts(tab.dataset.view, getState());
    });
  });
}

// Real daily series straight from the ledger/food rows in state (no more
// fabricated scaling). dod/mom = daily spend over 7/30 days, wow = daily
// protein over 14 days, trajectory = cumulative month-to-date spend.
export function buildTrendData(state) {
  const ledger = state.ledger || [];
  const foods = state.foodLogs || [];
  const today = new Date();
  const expenseOf = (r) => (r.direction === "expense" ? Math.abs(Number(r.amount || 0)) : 0);
  const dd = (point) => point.date.slice(8); // day-of-month label
  // Math.round(null) is 0, so rounding here would silently undo the null that
  // dailySeries went to the trouble of reporting. Absent stays absent all the
  // way to the renderer, which draws it as a gap.
  const toBars = (series) => series.map((p) => ({
    label: dd(p),
    value: p.value == null ? null : Math.round(p.value),
  }));

  const spend7 = dailySeries({ rows: ledger, today, days: 7, valueOf: expenseOf });
  const protein14 = dailySeries({ rows: foods, today, days: 14, valueOf: (r) => Number(r.protein_g || 0) });
  const spend30 = dailySeries({ rows: ledger, today, days: 30, valueOf: expenseOf });

  // A CUMULATIVE line is the one place absent should carry forward rather than
  // gap: "total spent so far" on a day you logged nothing is still the previous
  // total, not unknown. Adding null would coerce to +0 and give the same answer,
  // but saying so explicitly stops the next reader from "fixing" it into a gap.
  let run = 0;
  const cumulative = spend30.map((p) => {
    if (p.value != null) run += p.value;
    return { date: p.date, value: run };
  });

  return {
    dod: toBars(spend7),
    wow: toBars(protein14),
    mom: toBars(spend30),
    trajectory: toBars(cumulative),
  };
}
