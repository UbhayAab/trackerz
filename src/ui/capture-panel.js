import { $, $all } from "../utils/dom.js";
import { previewCaptureRoute } from "../services/capture-router.js";
import { updateState } from "../state/app-state.js";
import { runCapture } from "../services/agent-runner.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { renderSpendSuggestion, clearSpendSuggestion } from "./spend-suggestion.js";
import { renderAnswer, clearAnswer, answerFrom, bindAnswerCard } from "./answer-card.js";
import { classifyRequestKind } from "../../lib/request-router.mjs";
import { createVoiceToggle, paintVoiceButton, isLiveTranscriptionSupported } from "./voice-control.js";
import { enqueueCapture, markSending, markSent, markFailed } from "../services/offline-queue.js";
import { recordLatency, bucketFor } from "../services/latency-stats.js";
import { setLiveDetail, renderOutbox } from "./outbox-panel.js";
import { prepareAudioFiles, describeUpload } from "../services/audio-convert.js";
import { showToast } from "./toast.js";

let pendingMediaFiles = [];
// Per-file upload state for the strip under the buttons. `pending` mirrors what
// is attached right now; `inflight` is the snapshot being sent.
let inflightAttachments = [];

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
  inflightAttachments = [];
  renderAttachments();
  renderRoutePreview();
}

function handleCameraInputChange() {
  const input = $("#cameraInput");
  const file = input.files?.[0];
  if (!file) {
    // The camera Activity came back with nothing. On Android that is usually the
    // WebView being reclaimed while the camera was in front, and it used to be
    // completely silent - the photo the user thought they took simply was not
    // there. Say so rather than returning as if nothing had been asked for.
    setVoiceStatus("No photo came back from the camera. Try again, or attach it from Files.", "error");
    return;
  }
  pendingMediaFiles.push(file);
  updateState((state) => state.parseLog.unshift(`Camera capture attached: ${file.name}`));
  input.value = "";
  inflightAttachments = [];
  renderAttachments();
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
    inflightAttachments = [];
    renderAttachments();
    renderRoutePreview();
  }
}

// ---------------------------------------------------------------------------
// THE ATTACHMENT STRIP.
//
// "Camera works, sure... But if I take a photo and press on tick, does it really
// upload? I don't even know about the upload thing." He could not know: the only
// trace of an attached photo was one line inside a COLLAPSED <details>, and the
// upload itself had no on-screen state whatsoever. Now every file has a visible
// row that moves attached -> uploading -> uploaded, or names the failure.
// ---------------------------------------------------------------------------
function renderAttachments() {
  const host = document.querySelector("#captureAttachments");
  if (!host) return;
  const rows = inflightAttachments.length
    ? inflightAttachments
    : getCaptureFiles().map((f) => ({ file: f, status: "attached" }));
  if (!rows.length) {
    host.hidden = true;
    host.textContent = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = rows.map(({ file, status, error }) => {
    const d = describeUpload({ name: file.name, size: file.size, type: file.type }, { status, error });
    return `<div class="attachment-chip is-${d.tone}"><span class="attachment-name">${esc(d.name)}</span><span class="attachment-state">${esc(d.text)}</span></div>`;
  }).join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// The one always-visible line for voice and camera. `hidden` is toggled rather
// than the element being created on demand, so the aria-live region exists
// before it ever has text - a live region inserted at the same moment it gets
// content is frequently not announced at all.
function setVoiceStatus(message, tone = "info") {
  const el = document.querySelector("#voiceStatus");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.dataset.tone = tone;
  el.textContent = message;
}

async function handleSubmit() {
  const submitBtn = $("#submitCapture");
  // PROCESS IMPLIES STOP. Pressing Voice and then Process is the natural
  // gesture - the user has said their piece and wants it sent. Stopping first
  // also lets the recogniser flush its final phrase into the box, so the last
  // thing said is part of the capture rather than lost to the reset below.
  if (voice.isListening()) {
    submitBtn.disabled = true;
    await voice.stop();
    submitBtn.disabled = false;
  }

  const text = $("#captureText").value.trim();
  // Convert any audio the transcription API cannot read (webm, mp4) into 16 kHz
  // mono WAV. Without this a voice note uploads, 400s during extraction, gets
  // swallowed, and the UI still reports "Capture saved" over nothing.
  const allFiles = await prepareAudioFiles(getCaptureFiles());
  if (!text && allFiles.length === 0) {
    // Silence used to be the entire response to an empty submit.
    showToast("Type, speak, or attach something first.");
    return;
  }

  const captureType = activeMode();
  // Set once the outbox has the capture; it doubles as the row's identity on
  // screen, so what is rendered is exactly what is persisted.
  let outboxId = null;

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
  // Freeze the strip on what is actually being sent, BEFORE resetForm() wipes
  // the pending list. Without this the rows vanish the instant you press
  // Process, which is precisely when you want to see them.
  inflightAttachments = allFiles.map((f) => ({ file: f, status: "attached" }));
  renderAttachments();
  resetForm();

  // Timing for the learned ETA. The bar is drawn from this user's own past runs
  // of this SHAPE - a 30 s audio upload and a 2 s text capture have genuinely
  // different distributions and must not share one curve.
  const startedAt = Date.now();
  const bucket = bucketFor({ fileCount: allFiles.length, kinds: allFiles.map(inferKind) });

  updateState((state) => {
    state.parseLog.unshift(`Capture: ${text || `${allFiles.length} file(s)`}`);
    state.activeJob = { key: "queued", label: "Queued", detail: "Capture received.", stageIndex: 0, startedAt, bucket };
  });

  // OUTBOX FIRST, always - before any network call, and regardless of what
  // navigator.onLine claims.
  //
  // That flag is the reason captures used to die. It reports whether an
  // interface is up, not whether anything is reachable, so in a metro tunnel or
  // a basement it stays TRUE while every request hangs. Those hangs landed in
  // the catch, and resetForm() in the finally erased the words. The one path
  // that reliably destroyed a capture was the one hit furthest from a keyboard.
  //
  // Writing here first also means an app kill mid-flight is survivable: the item
  // is on disk in `sending`, and recoverOutbox() on the next boot hands it back
  // to the retry machine.
  try {
    outboxId = await enqueueCapture({
      text: [text, submitted.transcript].filter(Boolean).join("\n"),
      files: allFiles,
      captureType,
    });
    // Paint the queued row now, so the capture is visibly somewhere the instant
    // the box clears rather than only once the network answers.
    await renderOutbox();
  } catch (err) {
    // Storage itself is unavailable (private mode, quota, a tab holding an old
    // DB version). Say so rather than proceeding as if the capture were safe.
    console.error("[capture] outbox unavailable:", err);
    showToast("This browser won't let me save locally - don't close the app until this finishes.", { kind: "error", duration: 6000 });
  }

  if (!navigator.onLine) {
    updateOptimistic(outboxId, { status: "queued", detail: "Offline - saved on this phone, will send when you're back online." });
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift("Offline: capture waiting in the outbox.");
    });
    return;
  }

  if (outboxId) await markSending(outboxId).catch(() => null);

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
          updateOptimistic(outboxId, { status: s.key, detail: s.detail });
        },
        // Per FILE, not per capture. This is the answer to "does it really
        // upload?" - the row for that photo says uploading, then uploaded, or
        // names the reason it did not.
        onMedia(ev) {
          const row = inflightAttachments[ev.index];
          if (!row) return;
          row.status = ev.status;
          row.error = ev.error || "";
          renderAttachments();
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
    updateOptimistic(outboxId, {
      status: "done",
      detail: answered ? "Answered - nothing was logged." : "Saved. Review the action queue.",
    });
    // It landed. Release it from the outbox - the domain rows are the record
    // now, and a lingering item would sit in the queue depth forever.
    if (outboxId) await markSent(outboxId, result?.ingestion?.id || null).catch(() => null);
    setLiveDetail(outboxId, "");
    await renderOutbox();
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
    // The item is ALREADY in the outbox - it was written before the network call
    // - so this must hand it back to the retry machine, not enqueue a second
    // copy. The state machine decides whether it retries (offline, timeout, 5xx,
    // captive portal) or stops and asks (401, 402, 400), because retrying a
    // signed-out session forever drains the battery and retrying an
    // over-budget capture just spends more money.
    let outcome = null;
    if (outboxId) outcome = await markFailed(outboxId, err).catch(() => null);
    setLiveDetail(outboxId, "");
    await renderOutbox();

    if (!outboxId) {
      // The outbox was never available. Put the words back rather than swallow
      // them, but never clobber something typed since.
      const box = $("#captureText");
      if (box && !box.value.trim()) {
        box.value = [submitted.text, submitted.transcript].filter(Boolean).join("\n");
        renderRoutePreview();
      }
    }

    const willRetry = outcome?.state === "failed";
    const detail = willRetry
      ? `Couldn't send (${msg}) - saved on this phone, retrying.`
      : outcome?.state === "dead"
        ? `Couldn't send - ${describeDeath(outcome)}`
        : msg;
    updateOptimistic(outboxId, { status: willRetry ? "queued" : "error", detail });
    showToast(willRetry ? "Couldn't send - saved on this phone, retrying." : detail,
      { kind: "error", duration: 6000 });
    updateState((state) => {
      state.activeJob = null;
      state.parseLog.unshift(`Capture failed: ${msg}${willRetry ? " (queued for retry)" : ""}`);
    });
  }
}

// Why a capture stopped trying, in words that say what to DO about it. "Capture
// failed - [object Object]" tells the user nothing and is how a lost capture
// becomes a re-submit and a duplicate row.
function describeDeath(item) {
  switch (item?.lastErrorKind) {
    case "auth": return "you're signed out. Sign in, then tap Retry.";
    case "cap": return "today's AI budget is used up. It'll keep until tomorrow.";
    case "rejected": return "the server couldn't read that one.";
    default: return `${item?.lastError || "unknown error"}. Tap Retry.`;
  }
}

function resetForm() {
  if ($("#captureText")) $("#captureText").value = "";
  if ($("#fileInput")) $("#fileInput").value = "";
  pendingMediaFiles = [];
  renderRoutePreview();
}

// THE OUTBOX IS THE ROW NOW.
//
// These used to build and mutate their own DOM node in #optimisticQueue. That
// row existed only in memory, so a reload erased it while the capture itself was
// still queued in IndexedDB - the user saw nothing and had no way to tell "still
// trying" from "gone". src/ui/outbox-panel.js renders the same container from
// storage instead, so what is on screen is what is actually persisted.
//
// Kept as thin shims so the call sites stay readable: the in-flight stage text
// is the one thing the outbox cannot know by itself.
function updateOptimistic(id, { detail }) {
  if (!id) return;
  setLiveDetail(id, detail || "");
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

// ===========================================================================
// VOICE.
//
// THE BUG THIS SECTION EXISTS TO END, in the owner's words: "even when I
// capture, I'm talking something, it shows that it's kind of recording, but
// when I press on stop, nothing happens."
//
// He was right, and it was structural rather than intermittent. The old flow
// took the microphone with a recorder FIRST and started dictation second, and
// the recorder's stop handler reported what had happened by pushing one line
// into `state.parseLog` - which renders inside `<details class="capture-meta">`,
// closed by default. Measured on the real signed-in app: after pressing Stop,
// #captureText was "", no toast, #agentDetail unchanged, and the <details> shut.
// Stop was a visible no-op by construction.
//
// Fixing that was not enough, and he said so again: the two surfaces still felt
// different. Sharing the speech ENGINE left Home wrapping it in machinery Gym
// never had - a recorder running alongside the recogniser as "evidence", an
// automatic fallback to recording, and a Process press before anything became
// text. Two apps cannot hold the Android microphone at once, so competing with
// ourselves for it was the worst part of that.
//
// There is no recorder on this path any more. Voice is dictation, on both
// pages, through the one control below.
// ===========================================================================

// THE VOICE BUTTON IS THE SAME CONTROL AS THE GYM PAGE'S. NOT A COPY OF IT.
//
// This used to do three things Gym never did: run a MediaRecorder alongside the
// recogniser as "evidence", auto-fall-back to recording when dictation failed,
// and require a Process press before any of it became text. That is why the two
// still felt different after the engine was shared - the owner said so twice.
// Gym does exactly one thing: tap, words appear in the box, tap again to stop.
// So does this now, through ui/voice-control.js, which owns the markup, both
// labels, the active class and the stop semantics for both pages.
//
// Audio as evidence did not disappear - it moved to where it belongs. Attach an
// audio file with the Files button and it is transcribed on Process, exactly as
// before. It is simply no longer bolted onto the microphone button, where it was
// fighting the recogniser for a microphone Android only lets one app hold.
const voice = createVoiceToggle({
  getBox: () => document.querySelector("#captureText"),
  setStatus: (message) => setVoiceStatus(message, "busy"),
  onListeningChange: (listening) => {
    paintVoiceButton(document.querySelector("#voiceButton"), listening);
  },
});

async function handleVoiceClick() {
  await voice.toggle();
}
