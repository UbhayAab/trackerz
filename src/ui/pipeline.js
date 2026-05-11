import { pipelineSteps } from "../data/dashboard-data.js";
import { $ } from "../utils/dom.js";

export function renderPipeline() {
  $("#pipelineList").innerHTML = pipelineSteps
    .map((step) => `
      <article class="pipeline-step">
        <strong>${step.name}</strong>
        <span>${step.detail}</span>
      </article>
    `)
    .join("");
}
