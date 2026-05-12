import { parseCapture } from "./capture-parser.js";

export const aiStages = [
  { key: "queued", label: "Queued", eta: 4, detail: "Capture received and evidence stored." },
  { key: "extracting", label: "Extracting", eta: 3, detail: "Reading text, media names, and import hints." },
  { key: "reasoning", label: "Reasoning", eta: 2, detail: "DeepSeek-style planner is choosing typed actions." },
  { key: "validating", label: "Validating", eta: 1, detail: "Schemas, confidence, duplicate checks, and undo rails." },
  { key: "writing", label: "Updating tables", eta: 0, detail: "Applying safe rows and sending risky rows to review." },
];

export function runAiJob(capture, callbacks) {
  let index = 0;

  const tick = () => {
    const stage = aiStages[index];
    callbacks.onStage(stage, index);
    index += 1;

    if (index < aiStages.length) {
      setTimeout(tick, 650);
      return;
    }

    setTimeout(() => {
      callbacks.onComplete(parseCapture(capture));
    }, 450);
  };

  tick();
}
