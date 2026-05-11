import { getFlowsByDomain, getFlowStats } from "../../lib/flow-catalog.mjs";
import { $, $all } from "../utils/dom.js";

export function renderFlowLab(domain = "all") {
  const flows = getFlowsByDomain(domain);
  $("#flowCount").textContent = String(domain === "all" ? getFlowStats().total : flows.length);
  $("#flowList").innerHTML = flows
    .slice(0, 18)
    .map(
      (flow) => `
        <article class="flow-card">
          <header>
            <h3>${flow.title}</h3>
            <span class="flow-domain">${flow.domain}</span>
          </header>
          <p>${flow.trigger}</p>
          <p><strong>AI:</strong> ${flow.aiSteps.join(" -> ")}</p>
          <p><strong>Example:</strong> ${flow.examples[0]}</p>
        </article>
      `,
    )
    .join("");
}

export function bindFlowLab() {
  $all(".flow-filter").forEach((filter) => {
    filter.addEventListener("click", () => {
      $all(".flow-filter").forEach((item) => item.classList.remove("active"));
      filter.classList.add("active");
      renderFlowLab(filter.dataset.domain);
    });
  });
}
