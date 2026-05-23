import { aiStages } from "../ai/job-runner.js";
import { $ } from "../utils/dom.js";

export function renderAgentStatus(state) {
  if (!document.querySelector("#agentStatus")) return;
  const job = state.activeJob;
  const progress = job ? Math.round(((job.stageIndex + 1) / aiStages.length) * 100) : 0;
  const console = document.querySelector(".agent-console");
  if (console) console.dataset.state = job ? "running" : "idle";
  $("#agentStatus").textContent = job ? `${job.label}. ETA ${job.eta}s` : "Idle. Next capture will show every AI stage here.";
  $("#jobEta").textContent = job ? `~${job.eta}s` : "ready";
  $("#agentDetail").textContent = job ? job.detail : "No hidden work. When you process a capture, the tables update after validation.";
  $("#agentProgress").style.setProperty("--progress", `${progress}%`);
  $("#agentStageList").innerHTML = aiStages
    .map((stage) => {
      const active = job?.key === stage.key ? " active" : "";
      const done = job?.stageIndex > aiStages.findIndex((item) => item.key === stage.key) ? " done" : "";
      return `<span class="stage-dot${active}${done}">${stage.label}</span>`;
    })
    .join("");
  $("#parseLog").innerHTML = state.parseLog.slice(0, 5).map((line) => `<li>${line}</li>`).join("");
}
