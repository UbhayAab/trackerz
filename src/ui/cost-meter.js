import { $, $all } from "../utils/dom.js";
import { usd } from "../utils/formatters.js";
import { getCostEstimate } from "../services/cost-service.js";

export function renderCostMeter() {
  const images = Number($("#imagesPerDay").value);
  const voiceMinutes = Number($("#voicePerDay").value);
  const events = Number($("#eventsPerDay").value);
  const cost = getCostEstimate({ images, voiceMinutes, events });
  $("#monthlyCost").textContent = usd(cost.monthlyTotal);
  $("#costBreakdown").textContent =
    `${images} images/day, ${voiceMinutes} voice min/day, ${events} agent events/day. ` +
    `Estimated Gemini ${usd(cost.monthlyGemini)}/mo, DeepSeek ${usd(cost.monthlyDeepseek)}/mo.`;
}

export function bindCostMeter() {
  $all("#imagesPerDay, #voicePerDay, #eventsPerDay").forEach((input) => {
    input.addEventListener("input", renderCostMeter);
  });
}
