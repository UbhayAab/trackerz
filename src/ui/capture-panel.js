import { $, $all } from "../utils/dom.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";
import { runCapture } from "../services/agent-runner.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { startLiveTranscription, stopLiveTranscription, isLiveTranscriptionSupported } from "../services/speech.js";
import { enqueueCapture } from "../services/offline-queue.js";
import { showToast } from "./toast.js";

let recorder = null;
let chunks = [];
let pendingMediaFiles = [];
let liveTranscript = "";
let recognitionHandle = null;
let waveformHandle = null;
let optimisticCounter = 0;

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
  $("#captureText").addEventListener("paste", handlePaste);
  $("#fileInput").addEventListener("change", handleFileInputChange);
  $("#cameraInput")?.addEventListener("change", handleCameraInputChange);
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

function handleFileInputChange() {
  const input = $("#fileInput");
  if (!input) return;
  const count = input.files?.length || 0;
  if (count) updateState((state) => state.parseLog.unshift(`${count} file(s) attached.`));
  renderRoutePreview();
}

function handleCameraInputChange() {
  const input = $("#cameraInput");
  const file = input.files?.[0];
  if (!file) return;
  pendingMediaFiles.push(file);
  updateState((state) => state.parseLog.unshift(`Camera capture attached: ${file.name}`));
  input.value = "";
  renderRoutePreview();
}

function handlePaste(event) {
  const items = event.clipboardData?.items || [];
  let added = 0;
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        pendingMediaFiles.push(file);
        added += 1;
      }
    }
  }
  if (added > 0) {
    updateState((state) => state.parseLog.unshift(`${added} pasted file(s) attached.`));
    renderRoutePreview();
  }
}

async function handleSubmit() {
  const text = $("#captureText").value.trim();
  const allFiles = getCaptureFiles();
  if (!text && allFiles.length === 0 && !liveTranscript) return;

  const captureType = activeMode();
  const submitBtn = $("#submitCapture");
  submitBtn.disabled = true;
  const optimisticId = pushOptimistic({ text, transcript: liveTranscript, fileCount: allFiles.length, captureType });

  updateState((state) => {
    state.parseLog.unshift(`Capture: ${text || `${allFiles.length} file(s)`}${liveTranscript ? ` + voice` : ""}`);
    // No ETA: nothing here measures how long the agent takes, and an invented
    // one rendered as "~undefineds" in the header pill.
    state.activeJob = { key: "queued", label: "Queued", detail: "Capture received.", stageIndex: 0 };
  });

  if (!navigator.onLine) {
    await enqueueCapture({ text: [text, liveTranscript].filter(Boolean).join("\n"), files: allFiles, captureType });
    updateOptimistic(optimisticId, { status: "queued", detail: "Offline — saved locally, will sync when online." });
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift("Offline: capture stored in IndexedDB queue.");
    });
    resetForm();
    submitBtn.disabled = false;
    return;
  }

  try {
    await runCapture(
      { text, files: allFiles, captureType, transcript: liveTranscript },
      {
        onStage(s, idx) {
          updateState((state) => {
            state.activeJob = { ...s, stageIndex: idx };
            state.parseLog.unshift(`${s.label}: ${s.detail}`);
          });
          updateOptimistic(optimisticId, { status: s.key, detail: s.detail });
        },
      },
    );
    await hydrateStateFromSupabase();
    updateOptimistic(optimisticId, { status: "done", detail: "Saved. Review the action queue." });
    const had = allFiles.length > 0;
    showToast(had ? `Processed ${allFiles.length} file(s) — check the feed` : "Capture saved");
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift("Tables updated. Review queue and metrics refreshed.");
    });
  } catch (err) {
    const msg = err?.message || String(err);
    updateOptimistic(optimisticId, { status: "error", detail: msg });
    showToast(`Capture failed — ${msg}`, { kind: "error", duration: 6000 });
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift(`Capture failed: ${msg}`);
    });
  } finally {
    resetForm();
    submitBtn.disabled = false;
  }
}

function resetForm() {
  if ($("#captureText")) $("#captureText").value = "";
  if ($("#fileInput")) $("#fileInput").value = "";
  pendingMediaFiles = [];
  liveTranscript = "";
  renderRoutePreview();
}

// Same escaping as ui/toast.js — the optimistic row is built with innerHTML and
// the summary is whatever the user typed, pasted or dictated.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function pushOptimistic({ text, transcript, fileCount, captureType }) {
  const wrap = $("#optimisticQueue");
  if (!wrap) return null;
  optimisticCounter += 1;
  const id = `opt-${optimisticCounter}`;
  const row = document.createElement("div");
  row.className = "optimistic-row status-queued";
  row.id = id;
  const summary = text || transcript || `${fileCount} file(s)`;
  row.innerHTML = `
    <span class="optimistic-dot" aria-hidden="true"></span>
    <div class="optimistic-body">
      <strong>${escapeHtml(summary.slice(0, 80))}</strong>
      <span class="optimistic-status">${escapeHtml(captureType)} • queued</span>
    </div>
  `;
  wrap.prepend(row);
  setTimeout(() => row.classList.add("ready"), 20);
  return id;
}

function updateOptimistic(id, { status, detail }) {
  if (!id) return;
  const row = document.getElementById(id);
  if (!row) return;
  row.className = `optimistic-row status-${status || "running"} ready`;
  const label = row.querySelector(".optimistic-status");
  if (label) label.textContent = `${status} • ${detail || ""}`;
  if (status === "done") setTimeout(() => row.remove(), 6000);
}

function setVoiceLabel(button, text) {
  const label = button.querySelector(".voice-label");
  if (label) label.textContent = text;
  else button.textContent = text;
}

function activeMode() {
  const active = document.querySelector(".mode-card.active");
  return active?.dataset.mode || "auto";
}

function getCaptureFiles() {
  return [...Array.from($("#fileInput").files || []), ...pendingMediaFiles];
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
    stopWaveform();
    setVoiceLabel(button, "Voice");
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
    startWaveform(stream);

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
      stopWaveform();
      const blob = new Blob(chunks, { type: "audio/webm" });
      const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      const file = new File([blob], fileName, { type: "audio/webm" });
      pendingMediaFiles.push(file);
      updateState((state) => {
        state.activeJob = null;
        state.parseLog.unshift(liveTranscript
          ? `Voice transcript captured: "${liveTranscript.slice(0, 80)}"`
          : "Voice recording attached. Will be transcribed by Gemini on submit.");
      });
      renderRoutePreview();
    });

    recorder.start();
    setVoiceLabel(button, "Stop");
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

function startWaveform(stream) {
  const canvas = $("#voiceWaveform");
  if (!canvas || !globalThis.AudioContext) return;
  canvas.hidden = false;
  const ctx = canvas.getContext("2d");
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let stopped = false;

  function draw() {
    if (stopped) return;
    analyser.getByteFrequencyData(data);
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const barCount = data.length;
    const barWidth = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const v = data[i] / 255;
      const barHeight = Math.max(2, v * h);
      const x = i * barWidth;
      const y = (h - barHeight) / 2;
      ctx.fillStyle = `rgba(19, 138, 91, ${0.45 + v * 0.55})`;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    }
    requestAnimationFrame(draw);
  }
  draw();

  waveformHandle = {
    stop() {
      stopped = true;
      source.disconnect();
      audioCtx.close().catch(() => null);
      canvas.hidden = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

function stopWaveform() {
  try { waveformHandle?.stop(); } catch {}
  waveformHandle = null;
}
