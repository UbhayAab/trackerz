import { $, $all } from "../utils/dom.js";
import { runAiJob } from "../ai/job-runner.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";

let recorder = null;
let chunks = [];
let pendingAudioFiles = [];

export function renderRoutePreview() {
  const { captureType, route } = previewCaptureRoute({
    text: $("#captureText").value,
    files: getCaptureFiles(),
  });
  const media = route.mediaModel ? `${route.mediaModel} -> ` : "";
  $("#routePreview").textContent = `Auto route: ${captureType}. ${media}${route.brainModel}. ${route.reason}`;
}

export function bindCapturePanel() {
  $("#captureText").addEventListener("input", renderRoutePreview);
  $("#fileInput").addEventListener("change", renderRoutePreview);

  $("#submitCapture").addEventListener("click", () => {
    const text = $("#captureText").value.trim();
    const files = getCaptureFiles().map((file) => ({ name: file.name, type: file.type, kind: file.kind }));
    const hasText = text.length > 0;
    const hasFiles = files.length > 0;
    if (!hasText && !hasFiles) return;
    const { captureType } = previewCaptureRoute({ text, files });
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
            state.metrics.caloriesLeft = Math.max(0, state.metrics.caloriesLeft - updates.metricsDelta.calories);
            state.metrics.habitScore = Math.max(0, Math.min(100, state.metrics.habitScore + updates.metricsDelta.habit));
            state.metrics.adherence = Math.max(0, Math.min(100, state.metrics.adherence + updates.metricsDelta.adherence));
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
    pendingAudioFiles = [];
    renderRoutePreview();
  });

  $("#voiceButton").addEventListener("click", handleVoiceClick);

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

function getCaptureFiles() {
  return [...Array.from($("#fileInput").files || []), ...pendingAudioFiles];
}

async function handleVoiceClick() {
  const button = $("#voiceButton");
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    button.textContent = "Record voice";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    pendingAudioFiles.push({ name: `voice-note-${Date.now()}.webm`, type: "audio/webm", kind: "audio" });
    updateState((state) => {
      state.parseLog.unshift("Audio capture queued. Browser recording is unavailable here, so Gemini transcription will run on uploaded audio in Supabase.");
    });
    renderRoutePreview();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      pendingAudioFiles.push({
        name: `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
        type: blob.type,
        kind: "audio",
        size: blob.size,
      });
      updateState((state) => {
        state.parseLog.unshift("Voice recording attached. Process will queue it for Gemini audio extraction.");
      });
      renderRoutePreview();
    });
    recorder.start();
    button.textContent = "Stop voice";
    updateState((state) => {
      state.parseLog.unshift("Recording voice. Tap Stop voice when done.");
    });
  } catch {
    updateState((state) => {
      state.parseLog.unshift("Microphone permission was blocked. Use Add files with an audio recording instead.");
    });
  }
}
