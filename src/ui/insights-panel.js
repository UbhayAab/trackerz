import { $ } from "../utils/dom.js";

export function renderInsights(state) {
  if (!document.querySelector("#insightList")) return;
  $("#insightList").innerHTML = state.insights.map((item) => `<li>${item}</li>`).join("");
}

export function bindInsights() {
  if (!document.querySelector("#refreshInsights")) return;
  $("#refreshInsights").addEventListener("click", () => {
    const first = $("#insightList li");
    if (first) first.textContent = `Refreshed: ${first.textContent}`;
  });
}
