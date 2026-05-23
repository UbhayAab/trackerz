import { $ } from "../utils/dom.js";

// The capture pipeline is structural, not data — these are the fixed steps every
// ingestion goes through. They live in code (not the DB) on purpose.
export const pipelineSteps = [
  { name: "Intake", detail: "Raw text, voice, images, bank files, notes" },
  { name: "Extract", detail: "Gemini vision + OCR + file parser produce evidence" },
  { name: "Reason", detail: "Gemini 2.5 Flash returns typed tool calls only" },
  { name: "Validate", detail: "Schema, confidence, RLS, dedupe, rate-limit" },
  { name: "Write", detail: "Audited DB action with undo payload" },
];

export function renderPipeline() {
  const el = $("#pipelineList");
  if (!el) return;
  el.innerHTML = pipelineSteps
    .map((step) => `
      <article class="pipeline-step">
        <strong>${step.name}</strong>
        <span>${step.detail}</span>
      </article>
    `)
    .join("");
}
