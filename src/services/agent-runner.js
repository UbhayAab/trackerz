import { getSupabaseClient } from "./supabase-client.js";
import { insertRawIngestion, uploadMediaFile } from "./supabase-data.js";
import { runCrossSourceDedupe } from "./dedupe-scan.js";

const STAGES = [
  { key: "queued",     label: "Queued",          detail: "Capture received." },
  { key: "uploading",  label: "Uploading",       detail: "Storing raw input." },
  { key: "extracting", label: "Extracting",      detail: "Reading text, image, or audio." },
  { key: "reasoning",  label: "Reasoning",       detail: "Choosing tool calls." },
  { key: "dedupe",     label: "Dedupe scan",     detail: "Checking for repeats across sources." },
  { key: "writing",    label: "Writing",         detail: "Persisting candidates and metrics." },
  { key: "done",       label: "Done",            detail: "Tables refreshed." },
];

function stage(key, overrides = {}) {
  const base = STAGES.find((s) => s.key === key) || STAGES[0];
  return { ...base, ...overrides };
}

export async function runCapture({ text = "", files = [], captureType = "auto", transcript = "" }, { onStage } = {}) {
  const sourceType = inferSourceType(text, files, transcript);
  const mode = captureType === "food" ? "diet" : captureType === "money" ? "money" : captureType === "wellness" ? "wellness" : "auto";

  onStage?.(stage("queued"), 0);

  const combinedText = [text, transcript].filter(Boolean).join("\n").trim();
  const ingestion = await insertRawIngestion({
    sourceType,
    captureMode: mode,
    rawText: combinedText || null,
    occurredAt: new Date().toISOString(),
  });

  onStage?.(stage("uploading", { detail: `Saved raw ingestion ${shortId(ingestion.id)}.` }), 1);

  const mediaAssets = [];
  for (const file of files) {
    if (!(file instanceof Blob) && !(file?.arrayBuffer)) continue;
    const asset = await uploadMediaFile(file, { kind: pickKind(file), ingestionId: ingestion.id });
    mediaAssets.push(asset);
  }

  onStage?.(stage("extracting", { detail: mediaAssets.length ? `${mediaAssets.length} media file(s) uploaded.` : "Text input only." }), 2);

  const supabase = await getSupabaseClient();
  onStage?.(stage("reasoning"), 3);

  let agentResp = null;
  let fnErr = null;
  try {
    const result = await supabase.functions.invoke("agent", {
      body: {
        ingestionId: ingestion.id,
        userId: ingestion.user_id,
        sourceType,
        text: combinedText,
        mode,
        mediaAssetIds: mediaAssets.map((a) => a.id),
      },
    });
    agentResp = result.data;
    fnErr = result.error;
  } catch (err) {
    fnErr = err;
  }

  if (fnErr || !agentResp?.toolCalls) {
    // Edge function unavailable / older version. Save a review action client-side
    // so the capture is not lost.
    await supabase.from("ai_actions").insert({
      user_id: ingestion.user_id,
      ingestion_id: ingestion.id,
      tool_name: "request_user_review",
      arguments: {
        reason: fnErr ? `agent_error: ${fnErr.message || fnErr}` : "agent_returned_empty",
        raw_text: combinedText,
        source_type: sourceType,
      },
      confidence: 0.4,
      status: "proposed",
    });
    onStage?.(stage("dedupe", { detail: `Agent unavailable; capture queued for review.` }), 4);
  } else {
    onStage?.(stage("dedupe", { detail: `${agentResp.toolCalls.length || 0} tool call(s) proposed.` }), 4);
  }
  const dedupeResult = await runCrossSourceDedupe({ since: ingestion.created_at }).catch(() => ({ pairs: 0 }));
  if (dedupeResult.pairs > 0) {
    onStage?.(stage("dedupe", { detail: `${dedupeResult.pairs} possible duplicate(s) flagged.` }), 4);
  }
  onStage?.(stage("writing"), 5);
  onStage?.(stage("done"), 6);

  return { ingestion, mediaAssets, agentResp, dedupe: dedupeResult };
}

function inferSourceType(text, files, transcript) {
  if (files.length === 0) return text || transcript ? "text" : "text";
  if (files.length > 1) return "mixed";
  const f = files[0];
  const mime = f.type || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function pickKind(file) {
  const mime = file.type || "";
  if (mime === "application/pdf" || mime.includes("excel") || mime.includes("spreadsheet") || mime === "text/csv") return "statement";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function shortId(id) {
  return id?.slice(0, 8) || "—";
}
