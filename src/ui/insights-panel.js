import { insights } from "../data/dashboard-data.js";
import { $ } from "../utils/dom.js";

export function renderInsights() {
  $("#insightList").innerHTML = insights.map((item) => `<li>${item}</li>`).join("");
  $("#refreshInsights").addEventListener("click", () => {
    $("#insightList").innerHTML = insights
      .map((item, index) => `<li>${index === 0 ? "Refreshed: " : ""}${item}</li>`)
      .join("");
  });
}
