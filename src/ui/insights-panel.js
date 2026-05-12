import { $ } from "../utils/dom.js";

export function renderInsights(state) {
  $("#insightList").innerHTML = state.insights.map((item) => `<li>${item}</li>`).join("");
}

export function bindInsights() {
  $("#refreshInsights").addEventListener("click", () => {
    const first = $("#insightList li");
    if (first) first.textContent = `Refreshed: ${first.textContent}`;
  });
}
