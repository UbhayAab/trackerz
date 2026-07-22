import { $ } from "../utils/dom.js";

// The stage sequence is not known up front: the live agent pipeline, the local
// fallback and live transcription each report a different set of stages. This
// panel used to light up a hardcoded five-stage list from ai/job-runner.js that
// the real runner never emits, so it marked stages done that never ran and left
// the ones that did run dark. We accumulate what the job actually reports.
let reportedStages = [];

// Same escaping as ui/toast.js - capture text, file names and transcripts flow
// into the parse log verbatim, and a capture containing markup would execute.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function trackStages(job) {
  if (!job) {
    reportedStages = [];
    return reportedStages;
  }
  const index = Number.isInteger(job.stageIndex) ? job.stageIndex : reportedStages.length;
  reportedStages[index] = { key: job.key, label: job.label || job.key };
  // Truncating keeps a new (or shorter) run from inheriting the tail of the last one.
  reportedStages.length = index + 1;
  return reportedStages;
}

export function renderAgentStatus(state) {
  if (!document.querySelector("#agentStatus")) return;
  const job = state.activeJob;
  const stages = trackStages(job);

  // No stage total exists to divide by, so the bar advances one notch per
  // reported stage and only fills when the runner reports its terminal stage.
  const progress = !job ? 0 : job.key === "done" ? 100 : Math.min(92, stages.length * 14);

  // Most jobs carry no ETA. Show one only when the runner actually supplies a
  // number - concatenating an absent one produced the "~undefineds" pill.
  const eta = Number.isFinite(job?.eta) ? `${job.eta}s` : null;

  const consoleEl = document.querySelector(".agent-console");
  if (consoleEl) consoleEl.dataset.state = job ? "running" : "idle";

  $("#agentStatus").textContent = job
    ? eta ? `${job.label}. ETA ${eta}` : job.label
    : "Idle. Next capture will show every AI stage here.";
  $("#jobEta").textContent = job ? eta ? `~${eta}` : job.label : "ready";
  $("#agentDetail").textContent = job ? job.detail : "No hidden work. When you process a capture, the tables update after validation.";
  $("#agentProgress").style.setProperty("--progress", `${progress}%`);
  $("#agentStageList").innerHTML = stages
    .map((stage, index) => {
      if (!stage) return "";
      const isCurrent = index === stages.length - 1 && job.key !== "done";
      const status = isCurrent ? " active" : " done";
      return `<span class="stage-dot${status}">${escapeHtml(stage.label)}</span>`;
    })
    .join("");
  $("#parseLog").innerHTML = state.parseLog.slice(0, 5).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
}
