import { getState } from "../state/app-state.js";
import { $, $all } from "../utils/dom.js";
import { dailySeries } from "../analytics/period-aggregator.js";

let currentView = "dod";

export function renderCharts(view = currentView, state = getState()) {
  currentView = view || currentView;
  const data = buildTrendData(state)[currentView];
  const max = Math.max(1, ...data.map((point) => point.value));
  $("#activeViewLabel").textContent = currentView.toUpperCase();
  $("#chart").innerHTML = data
    .map((point) => {
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
  const toBars = (series) => series.map((p) => ({ label: dd(p), value: Math.round(p.value) }));

  const spend7 = dailySeries({ rows: ledger, today, days: 7, valueOf: expenseOf });
  const protein14 = dailySeries({ rows: foods, today, days: 14, valueOf: (r) => Number(r.protein_g || 0) });
  const spend30 = dailySeries({ rows: ledger, today, days: 30, valueOf: expenseOf });

  let run = 0;
  const cumulative = spend30.map((p) => { run += p.value; return { date: p.date, value: run }; });

  return {
    dod: toBars(spend7),
    wow: toBars(protein14),
    mom: toBars(spend30),
    trajectory: toBars(cumulative),
  };
}
