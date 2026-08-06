import { $ } from "../utils/dom.js";
import { progressAt, etaLabel } from "../../lib/eta.mjs";
import { samplesFor } from "../services/latency-stats.js";

// While a job is running the bar has to advance on its own - the stage callbacks
// fire a handful of times across 5-46 s, so redrawing only on those left the bar
// visibly frozen between them. Cleared the moment the job ends.
let tick = null;
let onTick = null;

export function bindAgentStatusTicker(rerender) {
  onTick = rerender;
}

function startTicker() {
  if (tick || !onTick) return;
  tick = setInterval(() => onTick?.(), 500);
}

function stopTicker() {
  if (tick) clearInterval(tick);
  tick = null;
}

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

  // The bar is the empirical CDF of this user's own past runs of this shape: at
  // 50%, half of them had already finished by now. See lib/eta.mjs.
  //
  // It replaces `Math.min(92, stages.length * 14)`, which hit 92% the instant
  // reasoning started and then froze there for the whole 5-46 s model call. A
  // bar that stalls near the end reads as "crashed", not "working".
  const elapsed = job?.startedAt ? Math.max(0, Date.now() - job.startedAt) : 0;
  const samples = job ? samplesFor(job.bucket || "text") : [];
  const curve = job && job.key !== "done" ? progressAt(samples, elapsed) : null;
  const progress = !job ? 0 : job.key === "done" ? 100 : (curve?.pct ?? 0);

  // Only ever a real number. Concatenating an absent one is what produced the
  // "~undefineds" pill, which is why the ETA was removed entirely before.
  const eta = job && job.key !== "done" ? etaLabel(samples, elapsed) : null;

  if (job && job.key !== "done") startTicker(); else stopTicker();

  const consoleEl = document.querySelector(".agent-console");
  if (consoleEl) consoleEl.dataset.state = job ? "running" : "idle";

  const progressEl = $("#agentProgress");
  if (progressEl) {
    progressEl.dataset.mode = curve?.mode || "idle";
    progressEl.classList.toggle("is-slow", Boolean(curve?.slow));
    progressEl.setAttribute("role", "progressbar");
    if (curve?.mode === "determinate") {
      progressEl.setAttribute("aria-valuenow", String(progress));
      progressEl.setAttribute("aria-valuemin", "0");
      progressEl.setAttribute("aria-valuemax", "100");
    } else {
      progressEl.removeAttribute("aria-valuenow");
    }
    progressEl.setAttribute("aria-valuetext", job ? `${job.label}${eta ? `, ${eta}` : ""}` : "idle");
  }

  $("#agentStatus").textContent = job
    ? eta ? `${job.label} - ${eta}` : job.label
    : "Idle. Next capture will show every AI stage here.";
  $("#jobEta").textContent = job ? (eta || job.label) : "ready";
  $("#agentDetail").textContent = job ? job.detail : "No hidden work. When you process a capture, the tables update after validation.";
  if (progressEl) progressEl.style.setProperty("--progress", `${progress}%`);
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
