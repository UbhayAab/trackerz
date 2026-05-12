import { $, $all } from "../utils/dom.js";
import { runAiJob } from "../ai/job-runner.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";

export function renderRoutePreview() {
  const { captureType, route } = previewCaptureRoute({
    text: $("#captureText").value,
    files: $("#fileInput").files,
  });
  const media = route.mediaModel ? `${route.mediaModel} -> ` : "";
  $("#routePreview").textContent = `Auto route: ${captureType}. ${media}${route.brainModel}. ${route.reason}`;
}

export function bindCapturePanel() {
  $("#captureText").addEventListener("input", renderRoutePreview);
  $("#fileInput").addEventListener("change", renderRoutePreview);

  $("#submitCapture").addEventListener("click", () => {
    const text = $("#captureText").value.trim();
    const files = Array.from($("#fileInput").files).map((file) => ({ name: file.name, type: file.type }));
    const hasText = text.length > 0;
    const hasFiles = files.length > 0;
    if (!hasText && !hasFiles) return;
    const { captureType } = previewCaptureRoute({ text, files: $("#fileInput").files });
    $("#submitCapture").disabled = true;
    updateState((state) => {
      state.parseLog.unshift(`Capture received: ${text || `${files.length} file(s)`}`);
      state.activeJob = { key: "queued", label: "Queued", eta: 4, detail: "Capture received.", stageIndex: 0 };
    });
    runAiJob(
      { text, files, captureType },
      {
        onStage(stage, stageIndex) {
          updateState((state) => {
            state.activeJob = { ...stage, stageIndex };
            state.parseLog.unshift(`${stage.label}: ${stage.detail}`);
          });
        },
        onComplete(updates) {
          updateState((state) => {
            state.reviewRows = [...updates.reviewRows, ...state.reviewRows];
            state.ledgerRows = [...updates.ledgerRows, ...state.ledgerRows];
            state.importRows = [...updates.importRows, ...state.importRows];
            state.macroRows = [...updates.macroRows, ...state.macroRows];
            state.insights = [...updates.insights, ...state.insights].slice(0, 8);
            state.metrics.todaySpend += updates.metricsDelta.spend;
            state.metrics.protein = Math.min(state.metrics.proteinTarget + 35, state.metrics.protein + updates.metricsDelta.protein);
            state.metrics.habitScore = Math.max(0, Math.min(100, state.metrics.habitScore + updates.metricsDelta.habit));
            state.metrics.habitNote = updates.metricsDelta.habit < 0 ? "Sleep recovery needs attention" : "Fresh capture applied";
            state.activeJob = null;
            state.parseLog.unshift("Tables updated. Review queue, ledger, macros, and insights refreshed.");
          });
          $("#submitCapture").disabled = false;
        },
      },
    );
    $("#captureText").value = "";
    $("#fileInput").value = "";
    renderRoutePreview();
  });

  $("#voiceButton").addEventListener("click", () => {
    $("#captureText").value = "Voice note: spent 500 fuel, lunch was dal rice curd, slept 6 hours and walked 7000 steps";
    updateState((state) => {
      state.parseLog.unshift("Voice placeholder inserted. Real mic capture will route through Gemini/audio extraction.");
    });
    renderRoutePreview();
  });

  $all(".mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      $all(".mode-card").forEach((item) => item.classList.remove("active"));
      card.classList.add("active");
    });
  });

  $all(".quick-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("#captureText").value = chip.dataset.template;
      $("#captureText").focus();
      renderRoutePreview();
    });
  });
}
