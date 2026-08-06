import { $, $all } from "../utils/dom.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";
import { runCapture } from "../services/agent-runner.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { renderSpendSuggestion, clearSpendSuggestion } from "./spend-suggestion.js";
import { renderAnswer, clearAnswer, answerFrom, bindAnswerCard } from "./answer-card.js";
import { classifyRequestKind } from "../../lib/request-router.mjs";
import { startDictation, isLiveTranscriptionSupported, collapseStutter } from "../services/speech.js";
import { enqueueCapture } from "../services/offline-queue.js";
import { recordLatency, bucketFor } from "../services/latency-stats.js";
import { showToast } from "./toast.js";

let recorder = null;
let chunks = [];
let pendingMediaFiles = [];
let liveTranscript = "";
let recognitionHandle = null;
let waveformHandle = null;
let optimisticCounter = 0;
// The textarea contents at the moment dictation started. Live text is rendered
// as `voiceBaseText + transcript` so speaking never eats something already typed.
let voiceBaseText = "";
// Resolves when an in-flight recording has produced its Blob. Submitting while
// recording awaits this instead of losing the audio - see finalizeVoice.
let recorderStopped = null;

// How long Process waits for MediaRecorder to flush its final chunk. The box has
// already cleared and the pending row is already on screen, so this is invisible.
const RECORDER_FLUSH_MS = 800;

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
  bindAnswerCard();
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
  const submitBtn = $("#submitCapture");
  // PROCESS IMPLIES STOP. Pressing Voice and then Process is the natural
  // gesture - the user has said their piece and wants it sent. It used to lose
  // the recording entirely: the audio File is only built inside the recorder's
  // `stop` listener, which fired AFTER resetForm() had wiped pendingMediaFiles,
  // so the blob landed in the NEXT capture's array. Finalise first, then read.
  if (recorder && recorder.state === "recording") {
    submitBtn.disabled = true;
    await finalizeVoice();
    submitBtn.disabled = false;
  }

  const text = $("#captureText").value.trim();
  const allFiles = getCaptureFiles();
  if (!text && allFiles.length === 0 && !liveTranscript) {
    // Silence used to be the entire response to an empty submit.
    showToast("Type, speak, or attach something first.");
    return;
  }

  const captureType = activeMode();
  const optimisticId = pushOptimistic({ text, transcript: liveTranscript, fileCount: allFiles.length, captureType });

  // CLEAR THE BOX NOW, not in `finally`. resetForm() used to run after the whole
  // round trip, so the text sat there for the entire 6-46 s the agent takes
  // (p50 12.3 s, p90 27.1 s, max 45.7 s measured from ai_runs.latency_ms) with
  // the button greyed out and nothing else to look at. The pending row below is
  // what carries the truth from here on.
  // NOTE: transcript is deliberately empty. Live dictation now writes straight
  // into the textarea, so it is already part of `text`; runCapture joins text
  // and transcript with a newline, and passing both would send every dictated
  // sentence to the model twice. When live transcription is unavailable (an
  // Android WebView has no Web Speech API at all) there is no transcript to
  // send anyway - the audio file is transcribed server-side instead.
  const submitted = { text, files: allFiles, transcript: "", captureType };
  resetForm();

  // Timing for the learned ETA. The bar is drawn from this user's own past runs
  // of this SHAPE - a 30 s audio upload and a 2 s text capture have genuinely
  // different distributions and must not share one curve.
  const startedAt = Date.now();
  const bucket = bucketFor({ fileCount: allFiles.length, kinds: allFiles.map(inferKind) });

  updateState((state) => {
    state.parseLog.unshift(`Capture: ${text || `${allFiles.length} file(s)`}${liveTranscript ? ` + voice` : ""}`);
    state.activeJob = { key: "queued", label: "Queued", detail: "Capture received.", stageIndex: 0, startedAt, bucket };
  });

  if (!navigator.onLine) {
    await enqueueCapture({ text: [text, submitted.transcript].filter(Boolean).join("\n"), files: allFiles, captureType });
    updateOptimistic(optimisticId, { status: "queued", detail: "Offline - saved on this phone, will send when you're back online." });
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift("Offline: capture stored in IndexedDB queue.");
    });
    return;
  }

  clearSpendSuggestion();
  clearAnswer();
  try {
    const result = await runCapture(
      { text, files: allFiles, captureType, transcript: submitted.transcript },
      {
        onStage(s, idx) {
          updateState((state) => {
            state.activeJob = { ...s, stageIndex: idx, startedAt, bucket };
            state.parseLog.unshift(`${s.label}: ${s.detail}`);
          });
          updateOptimistic(optimisticId, { status: s.key, detail: s.detail });
        },
      },
    );
    await hydrateStateFromSupabase();
    // Offer a remembered price when the capture named a known meal but no amount.
    // renderSpendSuggestion no-ops on null, so a capture with nothing to suggest
    // (the common case) shows nothing.
    if (result?.spendSuggestion) {
      renderSpendSuggestion(result.spendSuggestion, { ingestionId: result.suggestionIngestionId });
    }
    // The capture was a question, and the model answered it. Show the reply
    // instead of the usual "saved" line - nothing was logged, so claiming a
    // save would be false.
    let answered = answerFrom(result);
    // A question that produced no reply and no row must not report "Saved".
    // The reasoning model occasionally returns nothing parseable, and the old
    // behaviour was to show the normal success line - so asking something and
    // getting silence looked identical to logging a meal. Say what happened.
    if (!answered && classifyRequestKind(text) === "query") {
      const wrote = (result?.toolCalls || []).some((c) => String(c?.name || "").startsWith("create_"));
      if (!wrote) {
        answered = {
          question: text,
          answer: "I could not work that one out just now - the reasoning model came back empty. Nothing was logged. Try asking again, or more specifically.",
          basis: "",
        };
      }
    }
    if (answered) renderAnswer(answered);
    updateOptimistic(optimisticId, {
      status: "done",
      detail: answered ? "Answered - nothing was logged." : "Saved. Review the action queue.",
    });
    // Only a run that actually completed teaches the curve. Failures and
    // timeouts are not observations of how long success takes.
    recordLatency(bucket, Date.now() - startedAt);
    const had = allFiles.length > 0;
    if (answered) showToast("Answered");
    else showToast(had ? `Processed ${allFiles.length} file(s) - check the feed` : "Capture saved");
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift("Tables updated. Review queue and metrics refreshed.");
    });
  } catch (err) {
    const msg = err?.message || String(err);
    // The box was cleared on submit, so a failure here would otherwise DESTROY
    // the capture: the old code ran resetForm() in `finally` and the text was
    // simply gone. Queue it, so the only way to lose a capture is to discard it
    // deliberately. (Phase 3 moves every capture through the outbox by default;
    // this is the same guarantee, reached the short way.)
    let queued = false;
    try {
      await enqueueCapture({
        text: [submitted.text, submitted.transcript].filter(Boolean).join("\n"),
        files: submitted.files,
        captureType: submitted.captureType,
      });
      queued = true;
    } catch (queueErr) {
      // Both paths failed. Put the words back in the box rather than swallow
      // them - but never clobber something the user has typed since.
      const box = $("#captureText");
      if (box && !box.value.trim()) {
        box.value = [submitted.text, submitted.transcript].filter(Boolean).join("\n");
        renderRoutePreview();
      }
      console.error("[capture-panel] capture failed AND could not be queued:", queueErr);
    }
    updateOptimistic(optimisticId, {
      status: queued ? "queued" : "error",
      detail: queued ? `Couldn't send (${msg}) - saved on this phone, will retry.` : msg,
    });
    showToast(
      queued ? "Couldn't send - saved on this phone, will retry." : `Capture failed - ${msg}`,
      { kind: "error", duration: 6000 },
    );
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift(`Capture failed: ${msg}${queued ? " (queued for retry)" : ""}`);
    });
  }
}

function resetForm() {
  if ($("#captureText")) $("#captureText").value = "";
  if ($("#fileInput")) $("#fileInput").value = "";
  pendingMediaFiles = [];
  liveTranscript = "";
  voiceBaseText = "";
  renderRoutePreview();
}

// Same escaping as ui/toast.js - the optimistic row is built with innerHTML and
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

/**
 * Stop an in-flight recording and wait for its audio File to exist.
 *
 * MediaRecorder delivers its last chunk asynchronously, so `stop()` returning is
 * not the same as the Blob being ready. Bounded, because a provider that never
 * fires `stop` must not hang the submit - if the race expires we send the
 * transcript alone rather than nothing.
 */
async function finalizeVoice() {
  const button = $("#voiceButton");
  try { recognitionHandle?.stop(); } catch { /* already stopped */ }
  recognitionHandle = null;
  if (recorder && recorder.state === "recording") {
    const settled = recorderStopped;
    try { recorder.stop(); } catch { /* already stopped */ }
    await Promise.race([settled, new Promise((r) => setTimeout(r, RECORDER_FLUSH_MS))]);
  }
  stopWaveform();
  if (button) setVoiceLabel(button, "Voice");
}

async function handleVoiceClick() {
  const button = $("#voiceButton");
  if (recorder && recorder.state === "recording") {
    await finalizeVoice();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    showToast("Recording isn't available in this browser. Attach an audio file instead.", { kind: "error" });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    liveTranscript = "";
    // Anything already typed stays; dictation appends to it.
    voiceBaseText = $("#captureText")?.value || "";
    recorder = new MediaRecorder(stream);
    startWaveform(stream);

    if (isLiveTranscriptionSupported()) {
      recognitionHandle = startDictation({
        onUpdate({ text }) {
          // STRAIGHT INTO THE BOX. This is the whole difference between the Gym
          // page's voice (which felt instant) and this one (which felt broken):
          // Gym wrote the transcript into its textarea, Home wrote it into
          // state.activeJob.detail, which renders inside a COLLAPSED <details>
          // and is therefore invisible. The user reported having to "click back
          // on voice" to make the text appear.
          //
          // Direct DOM write, deliberately not updateState: that serialises the
          // entire app state to localStorage and re-renders seven panels, and it
          // ran once per spoken word.
          liveTranscript = text;
          const box = $("#captureText");
          if (!box) return;
          box.value = voiceBaseText ? `${voiceBaseText} ${text}`.trim() : text;
        },
        onError(code, info) {
          if (info?.fatal) {
            showToast(info.message || code, { kind: "error", duration: 6000 });
            finalizeVoice();
          } else if (info?.message) {
            // Non-fatal: the MediaRecorder is still capturing and Gemini can
            // transcribe on submit, so say that rather than implying failure.
            updateState((state) => state.parseLog.unshift(info.message));
          }
        },
      });
    }

    // Resolves once the Blob exists, so Process can await it - see finalizeVoice.
    recorderStopped = new Promise((resolve) => {
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        stopWaveform();
        // The recorder's ACTUAL container, never a hardcoded guess. The old code
        // labelled every blob "audio/webm" regardless of what was produced, and
        // the Gemini API does not accept audio/webm at all - it takes wav, mp3,
        // aiff, aac, ogg and flac. So a voice note with no live transcription
        // silently produced no evidence, while the UI still said "Capture saved".
        const mime = (recorder?.mimeType || "audio/webm").split(";")[0];
        const ext = mime.split("/")[1] || "webm";
        const blob = new Blob(chunks, { type: mime });
        const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
        if (blob.size > 0) pendingMediaFiles.push(new File([blob], fileName, { type: mime }));
        updateState((state) => {
          state.activeJob = null;
          state.parseLog.unshift(liveTranscript
            ? `Voice transcript captured: "${liveTranscript.slice(0, 80)}"`
            : blob.size > 0
              ? "Voice recording attached. Will be transcribed on submit."
              : "Nothing was recorded.");
        });
        renderRoutePreview();
        resolve();
      }, { once: true });
    });

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    recorder.start();
    setVoiceLabel(button, "Stop");
  } catch (err) {
    // The bare `catch {}` here threw away the DOMException name, so a blocked
    // mic, a missing mic and an unsupported browser all produced one identical
    // line buried in a collapsed panel. Say which it was, out loud.
    const name = err?.name || "";
    const msg = name === "NotAllowedError"
      ? "Microphone is blocked. Enable it for this site, then tap Voice again."
      : name === "NotFoundError"
        ? "No microphone found. Attach an audio file instead."
        : `Couldn't start recording (${name || err?.message || "unknown error"}).`;
    showToast(msg, { kind: "error", duration: 6000 });
    updateState((state) => state.parseLog.unshift(msg));
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
