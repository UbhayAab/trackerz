import { $, $all } from "../utils/dom.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";
import { runCapture } from "../services/agent-runner.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { startLiveTranscription, stopLiveTranscription, isLiveTranscriptionSupported } from "../services/speech.js";
import { enqueueCapture } from "../services/offline-queue.js";
import { prepareImage, pickAudioMimeType, extForAudioMime, isMobileLike } from "../services/media-prep.js";
import { showToast } from "./toast.js";

let recorder = null;
let chunks = [];
let pendingMediaFiles = [];
let liveTranscript = "";
let recognitionHandle = null;
let waveformHandle = null;
let optimisticCounter = 0;
// Resolves when the in-flight recorder's "stop" handler has attached the audio
// file — handleSubmit awaits it so a fast Stop→Process gesture can't lose the
// recording to the async stop event.
let recorderStopPromise = null;

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

// Every attachment source (file picker, camera, paste, voice) lands in
// pendingMediaFiles so single files can be removed via their chip and the
// inputs can be cleared immediately.
function addFiles(files, label) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  pendingMediaFiles.push(...list);
  updateState((state) => state.parseLog.unshift(`${label}: ${list.map((f) => f.name || f.type).join(", ")}`));
  renderFileChips();
  renderRoutePreview();
}

function handleFileInputChange() {
  const input = $("#fileInput");
  if (!input?.files?.length) return;
  addFiles(input.files, `${input.files.length} file(s) attached`);
  input.value = "";
}

function handleCameraInputChange() {
  const input = $("#cameraInput");
  if (!input?.files?.length) return;
  addFiles(input.files, "Camera capture attached");
  input.value = "";
}

function handlePaste(event) {
  const items = event.clipboardData?.items || [];
  const files = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) addFiles(files, `${files.length} pasted file(s) attached`);
}

// Visible attachment chips under the textarea — the collapsed "AI activity" log
// is not a confirmation UI; a photo the user just took must be visibly attached.
function renderFileChips() {
  const wrap = $("#attachChips");
  if (!wrap) return;
  wrap.textContent = "";
  wrap.hidden = pendingMediaFiles.length === 0;
  pendingMediaFiles.forEach((file, idx) => {
    const chip = document.createElement("span");
    chip.className = `attach-chip${file.type?.startsWith("image/") ? " is-image" : ""}`;
    const name = document.createElement("span");
    name.className = "attach-chip-name";
    name.textContent = file.name || file.type || "attachment";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "attach-chip-x";
    x.setAttribute("aria-label", `Remove ${name.textContent}`);
    x.textContent = "×";
    x.addEventListener("click", () => {
      pendingMediaFiles.splice(idx, 1);
      renderFileChips();
      renderRoutePreview();
    });
    chip.append(name, x);
    wrap.appendChild(chip);
  });
}

async function handleSubmit() {
  // A fast Stop → Process gesture races the recorder's async stop event; wait
  // for the audio file to be attached before reading the file list.
  if (recorder && recorder.state === "recording") stopRecording();
  if (recorderStopPromise) await recorderStopPromise.catch(() => null);

  const text = $("#captureText").value.trim();
  let allFiles = getCaptureFiles();
  if (!text && allFiles.length === 0 && !liveTranscript) {
    showToast("Nothing to capture yet — type, attach, or record something", { kind: "warn" });
    return;
  }

  const captureType = activeMode();
  const submitBtn = $("#submitCapture");
  submitBtn.disabled = true;
  const optimisticId = pushOptimistic({ text, transcript: liveTranscript, fileCount: allFiles.length, captureType });

  // Downscale big photos before they travel (edge fn inlines media into Gemini
  // against a hard request cap — a 12 MB camera photo would silently die).
  allFiles = await Promise.all(allFiles.map((f) => prepareImage(f)));

  updateState((state) => {
    state.parseLog.unshift(`Capture: ${text || `${allFiles.length} file(s)`}${liveTranscript ? ` + voice` : ""}`);
    state.activeJob = { key: "queued", label: "Queued", eta: 5, detail: "Capture received.", stageIndex: 0 };
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
    const result = await runCapture(
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
    if (result?.degraded) {
      // The capture is saved but the AI could NOT process it — never show
      // success for this. (This exact masking is why photo/voice looked dead.)
      updateOptimistic(optimisticId, { status: "error", detail: result.reason || "AI could not process this" });
      showToast(`Saved for review, but AI processing failed — ${result.reason || "unknown error"}`, { kind: "warn", duration: 8000 });
      updateState((state) => {
        state.activeJob = null;
        state.parseLog.unshift(`Degraded capture: ${result.reason || "agent unavailable"}`);
      });
    } else {
      updateOptimistic(optimisticId, { status: "done", detail: "Saved. Review the action queue." });
      const had = allFiles.length > 0;
      showToast(had ? `Processed ${allFiles.length} file(s) — check the feed` : "Capture saved");
      updateState((state) => {
        state.activeJob = null;
        state.parseLog.unshift("Tables updated. Review queue and metrics refreshed.");
      });
    }
    resetForm();
  } catch (err) {
    const msg = err?.message || String(err);
    updateOptimistic(optimisticId, { status: "error", detail: msg });
    showToast(`Capture failed — ${msg}. Attachments kept; tap Process to retry.`, { kind: "error", duration: 8000 });
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift(`Capture failed: ${msg}`);
    });
    // Keep text + attachments so the user can simply retry.
  } finally {
    submitBtn.disabled = false;
  }
}

function resetForm() {
  if ($("#captureText")) $("#captureText").value = "";
  if ($("#fileInput")) $("#fileInput").value = "";
  pendingMediaFiles = [];
  liveTranscript = "";
  recorderStopPromise = null;
  renderFileChips();
  renderRoutePreview();
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
      <strong>${summary.slice(0, 80)}</strong>
      <span class="optimistic-status">${captureType} • queued</span>
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
  // File/camera inputs are drained into pendingMediaFiles on change (so chips
  // can remove single files); the inputs themselves are always empty here.
  return [...pendingMediaFiles];
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

function stopRecording() {
  const button = $("#voiceButton");
  try { recorder?.stop(); } catch { /* already stopped */ }
  stopLiveTranscription(recognitionHandle);
  recognitionHandle = null;
  stopWaveform();
  if (button) setVoiceLabel(button, "Voice");
}

async function handleVoiceClick() {
  const button = $("#voiceButton");
  if (recorder && recorder.state === "recording") {
    stopRecording();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    showToast("This browser can't record audio — attach an audio file instead", { kind: "error" });
    updateState((state) => {
      state.parseLog.unshift("Browser recording unavailable. Upload an audio file with Add files instead.");
    });
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = err?.name || "";
    const hint = name === "NotAllowedError"
      ? "Microphone is blocked — allow it for this site in browser settings, then retry"
      : `Microphone unavailable — ${name || err?.message || err}`;
    showToast(hint, { kind: "error", duration: 8000 });
    updateState((state) => {
      state.parseLog.unshift(`Mic error: ${name || err}`);
    });
    return;
  }

  try {
    chunks = [];
    liveTranscript = "";
    // Label the recording with the container the recorder ACTUALLY produces —
    // Safari records mp4/AAC, Firefox ogg; a hard-coded "audio/webm" made
    // Gemini reject iPhone voice notes silently.
    const preferredMime = pickAudioMimeType();
    recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
    startWaveform(stream);

    // On mobile, SpeechRecognition and MediaRecorder fight over the mic
    // (Android Chrome contention, iOS PWA service-not-allowed) — record only
    // and let Gemini transcribe server-side. Desktop gets live transcription.
    const useLive = isLiveTranscriptionSupported() && !isMobileLike();
    if (useLive) {
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

    let resolveStop;
    recorderStopPromise = new Promise((resolve) => { resolveStop = resolve; });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      stopWaveform();
      const realMime = (recorder?.mimeType || preferredMime || "audio/webm").split(";")[0];
      // When live transcription produced text, submit the transcript alone —
      // sending the audio too makes the server transcribe the same utterance
      // twice and double-log the event.
      if (!liveTranscript.trim() && chunks.length) {
        const blob = new Blob(chunks, { type: realMime });
        const ext = extForAudioMime(realMime);
        const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
        pendingMediaFiles.push(new File([blob], fileName, { type: realMime }));
      }
      recorder = null;
      updateState((state) => {
        state.activeJob = null;
        state.parseLog.unshift(liveTranscript
          ? `Voice transcript captured: "${liveTranscript.slice(0, 80)}"`
          : "Voice recording attached. Will be transcribed by Gemini on submit.");
      });
      renderFileChips();
      renderRoutePreview();
      resolveStop();
    });

    recorder.start();
    setVoiceLabel(button, "Stop");
    updateState((state) => {
      state.parseLog.unshift(useLive
        ? "Recording with live transcription. Tap Stop voice when done."
        : "Recording voice. Tap Stop when done — AI transcribes it on Process.");
    });
  } catch (err) {
    stream?.getTracks().forEach((track) => track.stop());
    showToast(`Recording failed — ${err?.message || err}`, { kind: "error" });
    updateState((state) => {
      state.parseLog.unshift(`Recording failed: ${err?.message || err}`);
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
  // Follow the theme instead of a hard-coded green.
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0f7a52";

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
      ctx.globalAlpha = 0.45 + v * 0.55;
      ctx.fillStyle = accent;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
      ctx.globalAlpha = 1;
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
