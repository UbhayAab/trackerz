import { bootWithAuth } from "./bootstrap.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession } from "../services/auth.js";
import { isLiveTranscriptionSupported } from "../services/speech.js";
import { hasSupabaseConfig } from "../config.js";
import { runCapture } from "../services/agent-runner.js";
import { insertRawIngestion, uploadMediaFile } from "../services/supabase-data.js";
import { pickAudioMimeType, extForAudioMime } from "../services/media-prep.js";
import { renderNav } from "../ui/navigation.js";

bootWithAuth(async () => {
  renderNav();
  await runChecks();
  document.getElementById("diagRunBtn").addEventListener("click", runChecks);
  document.getElementById("diagE2EBtn").addEventListener("click", runE2E);
  document.getElementById("diagCameraBtn")?.addEventListener("click", testCameraPath);
  document.getElementById("diagVoiceBtn")?.addEventListener("click", testVoicePath);
});

async function runChecks() {
  const checks = [
    { name: "Supabase config present", run: () => Promise.resolve(hasSupabaseConfig()) },
    { name: "Auth session active",     run: () => Promise.resolve(Boolean(getCurrentSession())) },
    { name: "Web Speech (Chrome only)", run: () => Promise.resolve(isLiveTranscriptionSupported()) },
    { name: "Supabase reachable",      run: pingSupabase },
    { name: "Profile row exists",       run: profileExists },
    { name: "Read ledger_entries",     run: readLedger },
    { name: "Read food_logs",          run: readFoodLogs },
    { name: "Read storage bucket",     run: readBucket },
    { name: "Edge function 'agent' reachable", run: pingEdgeFn },
  ];

  const list = document.getElementById("diagList");
  list.innerHTML = checks.map((c, i) => `<div class="diag-row" data-i="${i}"><span>${c.name}</span><span class="diag-status">…</span></div>`).join("");

  for (let i = 0; i < checks.length; i++) {
    const row = list.querySelector(`[data-i="${i}"] .diag-status`);
    row.textContent = "running";
    try {
      const ok = await checks[i].run();
      row.textContent = ok === true ? "OK" : (ok || "FAIL");
      row.className = "diag-status " + (ok === true ? "ok" : "fail");
    } catch (err) {
      row.textContent = `ERR: ${(err.message || err).toString().slice(0, 100)}`;
      row.className = "diag-status fail";
    }
  }
}

async function pingSupabase() {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("profiles").select("id").limit(1);
  if (error) throw error;
  return true;
}

async function profileExists() {
  const supabase = await getSupabaseClient();
  const session = getCurrentSession();
  if (!session) return "not signed in";
  const { data, error } = await supabase.from("profiles").select("id").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  return data ? true : "missing";
}

async function readLedger() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.from("ledger_entries").select("id").limit(1);
  if (error) throw error;
  return `OK (${data?.length || 0} row sample)`;
}

async function readFoodLogs() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.from("food_logs").select("id").limit(1);
  if (error) throw error;
  return `OK (${data?.length || 0} row sample)`;
}

async function readBucket() {
  const supabase = await getSupabaseClient();
  const session = getCurrentSession();
  if (!session) return "no session";
  const { data, error } = await supabase.storage.from("raw-media").list(session.user.id, { limit: 1 });
  if (error) throw error;
  return `OK (${data?.length || 0} obj)`;
}

async function pingEdgeFn() {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.functions.invoke("agent", {
    body: { ingestionId: "00000000-0000-0000-0000-000000000000", userId: "00000000-0000-0000-0000-000000000000", sourceType: "text", text: "ping" },
  });
  if (error && /403|401/.test(String(error.message))) return `${error.message} (auth-gated)`;
  if (error) return error.message;
  return true;
}

// ---- Media pipeline self-tests ----------------------------------------------
// Both use the agent function's diagnostic mode: media is uploaded and read by
// Gemini, the evidence text comes back verbatim, and NOTHING is written to the
// trackers (only an ai_runs cost row). Failures return the real error.

function say(el, msg) {
  el.textContent = msg;
}

async function runDiagnosticExtract({ file, hint }) {
  const ingestion = await insertRawIngestion({
    sourceType: file.type.startsWith("audio/") ? "audio" : "image",
    captureMode: "auto",
    rawText: `[diagnostic] ${hint}`,
    occurredAt: new Date().toISOString(),
  });
  const asset = await uploadMediaFile(file, {
    kind: file.type.startsWith("audio/") ? "audio" : "image",
    ingestionId: ingestion.id,
  });
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("agent", {
    body: { ingestionId: ingestion.id, sourceType: "image", diagnostic: true, mediaAssetIds: [asset.id] },
  });
  if (error) throw new Error(`edge function: ${error.message || error}`);
  return data;
}

// Draw a fake receipt onto a canvas so the test needs no camera permission and
// proves the whole photo path: upload → storage → edge download → Gemini OCR.
async function testCameraPath() {
  const out = document.getElementById("diagMediaOutput");
  say(out, "Drawing test receipt…");
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 480; canvas.height = 360;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 480, 360);
    ctx.fillStyle = "#111111"; ctx.font = "bold 28px sans-serif";
    ctx.fillText("TRACKERZ TEST CAFE", 40, 60);
    ctx.font = "22px sans-serif";
    ctx.fillText("1x Filter Coffee ....... Rs 123", 40, 130);
    ctx.fillText("1x Veg Sandwich ........ Rs 189", 40, 170);
    ctx.font = "bold 24px sans-serif";
    ctx.fillText("TOTAL: Rs 312", 40, 240);
    ctx.font = "18px sans-serif";
    ctx.fillText("UPI Ref 424242424242", 40, 300);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "diagnostic-receipt.jpg", { type: "image/jpeg" });

    say(out, "Uploading + asking Gemini to read it…");
    const res = await runDiagnosticExtract({ file, hint: "camera path self-test" });
    if (res.extractError) {
      say(out, `FAIL — Gemini extraction error:\n${res.extractError}\nmedia errors: ${JSON.stringify(res.mediaErrors)}`);
      return;
    }
    const text = res.evidenceText || "";
    const readTotal = /312/.test(text);
    say(out, `${readTotal ? "PASS" : "PARTIAL"} — Gemini read back:\n${text.slice(0, 600)}\n\n${readTotal ? "The Rs 312 total was recognized. Camera → Gemini works." : "Gemini answered but didn't find the Rs 312 total — inspect the text above."}`);
  } catch (err) {
    say(out, `FAIL — ${err.message || err}`);
  }
}

// Records ~4s from the real microphone (permission prompt + real container +
// upload + Gemini transcription) — the exact path a voice note takes.
async function testVoicePath() {
  const out = document.getElementById("diagMediaOutput");
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    say(out, "FAIL — this browser can't record audio (no MediaRecorder).");
    return;
  }
  let stream;
  try {
    say(out, "Requesting microphone…");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    say(out, `FAIL — microphone: ${err.name || err.message || err}. Allow mic access for this site and retry.`);
    return;
  }
  try {
    const mime = pickAudioMimeType();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [];
    rec.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
    const stopped = new Promise((r) => rec.addEventListener("stop", r));
    rec.start();
    say(out, `Recording 4 seconds (container: ${rec.mimeType || mime || "default"}) — SAY SOMETHING like "spent 250 on lunch"…`);
    await new Promise((r) => setTimeout(r, 4000));
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const realMime = (rec.mimeType || mime || "audio/webm").split(";")[0];
    const file = new File([new Blob(chunks, { type: realMime })], `diagnostic-voice.${extForAudioMime(realMime)}`, { type: realMime });
    say(out, `Uploading ${Math.round(file.size / 1024)} KB ${realMime} + asking Gemini to transcribe…`);
    const res = await runDiagnosticExtract({ file, hint: "voice path self-test" });
    if (res.extractError) {
      say(out, `FAIL — Gemini extraction error:\n${res.extractError}\nmedia errors: ${JSON.stringify(res.mediaErrors)}\ncontainer sent: ${realMime}`);
      return;
    }
    say(out, `PASS — Gemini heard:\n"${(res.evidenceText || "").slice(0, 500)}"\n\nIf that matches what you said, voice → Gemini works (container: ${realMime}).`);
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    say(out, `FAIL — ${err.message || err}`);
  }
}

async function runE2E() {
  const out = document.getElementById("diagE2EOutput");
  out.textContent = "Running...";
  try {
    const r = await runCapture(
      { text: `Diagnostics test paid 99 to TestMerchant on ${new Date().toISOString()}`, files: [], captureType: "money", transcript: "" },
      { onStage: (s) => { out.textContent += `\n${s.label}: ${s.detail}`; } },
    );
    out.textContent += `\n\nResult: ${JSON.stringify({
      ingestionId: r.ingestion?.id,
      toolCalls: r.agentResp?.toolCalls?.length || 0,
      dedupePairs: r.dedupe?.pairs,
    }, null, 2)}`;
  } catch (err) {
    out.textContent += `\n\nFAIL: ${err.message || err}`;
  }
}
