import { $, $all } from "../utils/dom.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";
import { runCapture } from "../services/agent-runner.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { startLiveTranscription, stopLiveTranscription, isLiveTranscriptionSupported } from "../services/speech.js";

let recorder = null;
let chunks = [];
let pendingAudioFiles = [];
let liveTranscript = "";
let recognitionHandle = null;

export function renderRoutePreview() {
  const captureTextEl = $("#captureText");
  if (!captureTextEl) return;
  const text = captureTextEl.value;
  const filesMeta = getCaptureFilesMeta();
  const { captureType, route } = previewCaptureRoute({ text, files: filesMeta });
  const media = route.mediaModel ? `${route.mediaModel} -> ` : "";
  const speech = isLiveTranscriptionSupported() ? "" : " (live transcription unavailable in this browser)";
  $("#routePreview").textContent = `Auto route: ${captureType}. ${media}${route.brainModel}. ${route.reason}${speech}`;
}

export function bindCapturePanel() {
  if (!$("#captureText")) return;
  $("#captureText").addEventListener("input", renderRoutePreview);
  $("#fileInput").addEventListener("change", renderRoutePreview);
  $("#submitCapture").addEventListener("click", handleSubmit);
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

async function handleSubmit() {
  const text = $("#captureText").value.trim();
  const allFiles = getCaptureFiles();
  if (!text && allFiles.length === 0 && !liveTranscript) return;

  const captureType = activeMode();
  const submitBtn = $("#submitCapture");
  submitBtn.disabled = true;

  updateState((state) => {
    state.parseLog.unshift(`Capture: ${text || `${allFiles.length} file(s)`}${liveTranscript ? ` + voice` : ""}`);
    state.activeJob = { key: "queued", label: "Queued", eta: 5, detail: "Capture received.", stageIndex: 0 };
  });

  try {
    await runCapture(
      { text, files: allFiles, captureType, transcript: liveTranscript },
      {
        onStage(s, idx) {
          updateState((state) => {
            state.activeJob = { ...s, stageIndex: idx };
            state.parseLog.unshift(`${s.label}: ${s.detail}`);
          });
        },
      },
    );
    await hydrateStateFromSupabase();
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift("Tables updated. Review queue and metrics refreshed.");
    });
  } catch (err) {
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift(`Capture failed: ${err.message || err}`);
    });
  } finally {
    $("#captureText").value = "";
    $("#fileInput").value = "";
    pendingAudioFiles = [];
    liveTranscript = "";
    submitBtn.disabled = false;
    renderRoutePreview();
  }
}

function activeMode() {
  const active = document.querySelector(".mode-card.active");
  return active?.dataset.mode || "auto";
}

function getCaptureFiles() {
  return [...Array.from($("#fileInput").files || []), ...pendingAudioFiles];
}

function getCaptureFilesMeta() {
  return getCaptureFiles().map((f) => ({ name: f.name, type: f.type, kind: inferKind(f) }));
}

function inferKind(f) {
  const mime = f.type || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.includes("excel") || mime.includes("spreadsheet") || mime === "text/csv") return "file";
  return "file";
}

async function handleVoiceClick() {
  const button = $("#voiceButton");
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    stopLiveTranscription(recognitionHandle);
    recognitionHandle = null;
    button.textContent = "Record voice";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    updateState((state) => {
      state.parseLog.unshift("Browser recording unavailable. Upload an audio file with Add files instead.");
    });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    liveTranscript = "";
    recorder = new MediaRecorder(stream);

    if (isLiveTranscriptionSupported()) {
      recognitionHandle = startLiveTranscription({
        onPartial(text) {
          liveTranscript = text;
          updateState((state) => {
            state.activeJob = { key: "transcribing", label: "Transcribing", detail: text || "Listening...", stageIndex: 0 };
          });
        },
        onError(err) {
          updateState((state) => {
            state.parseLog.unshift(`Speech recognition error: ${err}`);
          });
        },
      });
    }

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      const file = new File([blob], fileName, { type: "audio/webm" });
      pendingAudioFiles.push(file);
      updateState((state) => {
        state.activeJob = null;
        state.parseLog.unshift(liveTranscript
          ? `Voice transcript captured: "${liveTranscript.slice(0, 80)}"`
          : "Voice recording attached. Will be transcribed by Gemini on submit.");
      });
      renderRoutePreview();
    });

    recorder.start();
    button.textContent = "Stop voice";
    updateState((state) => {
      state.parseLog.unshift(isLiveTranscriptionSupported()
        ? "Recording with live transcription. Tap Stop voice when done."
        : "Recording voice. Tap Stop voice when done.");
    });
  } catch {
    updateState((state) => {
      state.parseLog.unshift("Microphone permission was blocked. Use Add files with an audio recording instead.");
    });
  }
}
