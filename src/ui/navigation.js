import { $all } from "../utils/dom.js";

const targets = {
  Capture: ".capture-panel",
  Money: "#ledgerTable",
  Diet: "#macroTable",
  Insights: "#insightList",
};

export function bindNavigation() {
  $all(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      $all(".nav-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const target = document.querySelector(targets[button.textContent.trim()]);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}
