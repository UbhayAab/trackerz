import { $ } from "../utils/dom.js";

export function renderInsights(state) {
  if (!document.querySelector("#insightList")) return;
  $("#insightList").innerHTML = state.insights.length
    ? state.insights.map((item) => `<li>${item}</li>`).join("")
    : "<li>No AI insights yet. Add your first capture and the summary will appear here.</li>";
}

export function bindInsights() {
  if (!document.querySelector("#refreshInsights")) return;
  $("#refreshInsights").addEventListener("click", () => {
    const first = $("#insightList li");
    if (first) first.textContent = `Refreshed: ${first.textContent}`;
  });
}
