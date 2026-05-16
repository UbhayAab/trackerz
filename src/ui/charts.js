import { getState } from "../state/app-state.js";
import { $, $all } from "../utils/dom.js";

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

function buildTrendData(state) {
  const spend = state.metrics.todaySpend;
  const protein = state.metrics.protein;
  const caloriesUsed = Math.max(0, 2100 - state.metrics.caloriesLeft);
  const reviews = state.reviewRows.length;
  const imports = state.importRows.length;
  const meals = state.macroRows.length;
  const habit = state.metrics.habitScore;
  const insights = state.insights.length;
  const foodRows = state.ledgerRows.filter((row) => /food|zomato|swiggy/i.test(`${row.category} ${row.merchant}`)).length;

  return {
    dod: [
      { label: "Spend", value: spend },
      { label: "Protein", value: protein },
      { label: "Calories", value: caloriesUsed },
      { label: "Reviews", value: reviews * 100 },
      { label: "Meals", value: meals * 100 },
      { label: "Imports", value: imports * 100 },
      { label: "Habit", value: habit },
    ],
    wow: [
      { label: "Ledger", value: state.ledgerRows.length * 100 },
      { label: "Meals", value: meals * 100 },
      { label: "Files", value: imports * 100 },
      { label: "Insights", value: insights * 100 },
    ],
    mom: [
      { label: "Spend", value: spend },
      { label: "Food", value: foodRows * 300 },
      { label: "Protein", value: protein * 10 },
      { label: "Reviews", value: reviews * 200 },
      { label: "Imports", value: imports * 300 },
    ],
    trajectory: [
      { label: "Spend", value: spend },
      { label: "Protein", value: protein * 10 },
      { label: "Calories", value: caloriesUsed },
      { label: "Habit", value: habit * 10 },
      { label: "Queue", value: reviews * 150 },
    ],
  };
}
