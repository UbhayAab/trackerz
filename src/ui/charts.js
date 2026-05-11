import { trendData } from "../data/dashboard-data.js";
import { $, $all } from "../utils/dom.js";

export function renderCharts(view) {
  const data = trendData[view];
  const max = Math.max(...data.map((point) => point.value));
  $("#activeViewLabel").textContent = view.toUpperCase();
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
      renderCharts(tab.dataset.view);
    });
  });
}
