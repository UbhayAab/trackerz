import { estimateMonthlyAiCost } from "../../lib/agent-core.mjs";

export function getCostEstimate({ images, voiceMinutes, events }) {
  return estimateMonthlyAiCost({
    imagesPerDay: images,
    voiceMinutesPerDay: voiceMinutes,
    agentEventsPerDay: events,
  });
}
