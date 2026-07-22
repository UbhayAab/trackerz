import { getSupabaseClient } from "./supabase-client.js";
import { insertRawIngestion, uploadMediaFile } from "./supabase-data.js";
import { runCrossSourceDedupe } from "./dedupe-scan.js";
import { parseCapture } from "../ai/capture-parser.js";
import { updateState } from "../state/app-state.js";
import { isLocalSession } from "./auth.js";

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

// A dropped invoke tells us nothing about what the server did — the edge function
// is the writer, and on 2026-07-09 a transport error after a successful write plus
// one re-submit put ~Rs 240 in the ledger for an Rs 80 purchase. So we ask the DB.
const RUN_POLL_TRIES = 3;
const RUN_POLL_MS = 1000;

// options.ingestionId: reuse an existing raw_ingestions row (an explicit user
// retry — see retryCapture); options.onIngestion: fires as soon as the row exists
// so a caller (e.g. the offline queue) can remember it and retry against it.
export async function runCapture({ text = "", files = [], captureType = "auto", transcript = "" }, { onStage, ingestionId = null, onIngestion } = {}) {
  const sourceType = inferSourceType(text, files, transcript);
  const mode = captureType === "food" ? "diet" : captureType === "money" ? "money" : captureType === "wellness" ? "wellness" : "auto";

  if (isLocalSession()) {
    return runLocalCapture({ text, files, captureType, transcript, sourceType }, { onStage });
  }

  onStage?.(stage("queued"), 0);

  const combinedText = [text, transcript].filter(Boolean).join("\n").trim();
  const supabase = await getSupabaseClient();

  // An explicit retry reuses the SAME row. Minting a fresh ingestion per attempt
  // is what made one capture look like three unrelated ones to the server, and it
  // re-uploads the media under new ids, which changes the capture's fingerprint.
  const reusedIngestion = ingestionId ? await loadIngestion(supabase, ingestionId) : null;
  const ingestion = reusedIngestion || await insertRawIngestion({
    sourceType,
    captureMode: mode,
    rawText: combinedText || null,
    occurredAt: new Date().toISOString(),
  });
  onIngestion?.(ingestion);

  // Retry with edited text: keep the one row but make it say what was actually
  // submitted. The server fingerprints raw_text, so an edit correctly reads as a
  // different capture instead of silently replaying the old one's result.
  if (reusedIngestion && (combinedText || null) !== (ingestion.raw_text ?? null)) {
    const { error: textErr } = await supabase
      .from("raw_ingestions").update({ raw_text: combinedText || null, status: "queued" }).eq("id", ingestion.id);
    if (textErr) throw textErr;
    ingestion.raw_text = combinedText || null;
  }

  onStage?.(stage("uploading", {
    detail: reusedIngestion
      ? `Retrying raw ingestion ${shortId(ingestion.id)} — no new capture row.`
      : `Saved raw ingestion ${shortId(ingestion.id)}.`,
  }), 1);

  let mediaAssets = reusedIngestion ? await loadMediaAssets(supabase, ingestion.id) : [];
  const reusedMedia = mediaAssets.length > 0;
  if (!reusedMedia) {
    for (const file of files) {
      if (!(file instanceof Blob) && !(file?.arrayBuffer)) continue;
      const asset = await uploadMediaFile(file, { kind: pickKind(file), ingestionId: ingestion.id });
      mediaAssets.push(asset);
    }
  }

  onStage?.(stage("extracting", {
    detail: !mediaAssets.length ? "Text input only."
      : reusedMedia ? `${mediaAssets.length} media file(s) already uploaded — reused.`
      : `${mediaAssets.length} media file(s) uploaded.`,
  }), 2);

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

  const failed = Boolean(fnErr) || !agentResp?.toolCalls;
  // A failed invoke does NOT mean nothing was written. Ask the DB whether a run
  // landed for this ingestion before saying the agent was unavailable — claiming
  // "unavailable" is what invites the re-submit that duplicates the ledger.
  const probe = failed ? await findRunForIngestion(supabase, ingestion.id) : { run: null, error: null };

  if (probe.run) {
    onStage?.(stage("dedupe", {
      detail: `Connection dropped, but the agent run landed (${probe.actionCount == null ? "action count unavailable" : `${probe.actionCount} action(s)`}). Nothing re-sent.`,
    }), 4);
  } else if (failed) {
    // Nothing found. Save a review action client-side so the capture is not lost.
    // probe.error means the poll itself failed: we do NOT know whether the write
    // landed, and the row must say so rather than assert "agent unavailable".
    const unverified = Boolean(probe.error);
    const { error: reviewErr } = await supabase.from("ai_actions").insert({
      user_id: ingestion.user_id,
      ingestion_id: ingestion.id,
      tool_name: "request_user_review",
      arguments: {
        reason: unverified
          ? `agent_error_unverified: ${fnErr?.message || fnErr || "agent_returned_empty"} (run lookup failed: ${probe.error.message || probe.error})`
          : fnErr ? `agent_error: ${fnErr.message || fnErr}` : "agent_returned_empty",
        // Tri-state on purpose: true = confirmed nothing was written, null = we
        // could not check. Never false-as-in-"we know it wrote".
        write_confirmed_absent: unverified ? null : true,
        raw_text: combinedText,
        source_type: sourceType,
      },
      confidence: 0.4,
      status: "proposed",
    });
    // A swallowed failure here loses the capture entirely and silently.
    if (reviewErr) throw new Error(`capture_review_row_failed: ${reviewErr.message} (agent also failed: ${fnErr?.message || fnErr || "empty response"})`);
    onStage?.(stage("dedupe", {
      detail: unverified
        ? `Agent call failed and the run could not be checked — capture queued for review. Check the feed before re-submitting.`
        : `Agent unavailable; capture queued for review.`,
    }), 4);
  } else if (agentResp.duplicate) {
    onStage?.(stage("dedupe", { detail: `Already recorded by an earlier run — no new rows written.` }), 4);
  } else {
    onStage?.(stage("dedupe", { detail: `${agentResp.toolCalls.length || 0} tool call(s) proposed.` }), 4);
  }
  if (agentResp?.warning) {
    console.warn("[agent-runner] agent warning:", agentResp.warning);
    onStage?.(stage("dedupe", { detail: `Agent warning: ${agentResp.warning}` }), 4);
  }
  const dedupeResult = await runCrossSourceDedupe({ since: ingestion.created_at }).catch((err) => ({ pairs: 0, error: err }));
  if (dedupeResult.pairs > 0) {
    onStage?.(stage("dedupe", { detail: `${dedupeResult.pairs} possible duplicate(s) flagged.` }), 4);
  } else if (dedupeResult.error) {
    // Surfaced, not swallowed: a thrown exception here used to look identical to
    // "scanned cleanly, found nothing" — the duplicate-candidates pipeline went
    // dark for weeks with zero signal anywhere. See dedupe-scan.js.
    console.error("[agent-runner] dedupe scan failed:", dedupeResult.error);
    onStage?.(stage("dedupe", { detail: `Dedupe check failed (${dedupeResult.error.message || "see console"}) — capture still saved.` }), 4);
  }
  // Never narrate a write that this attempt did not perform.
  const duplicate = agentResp?.duplicate === true;
  const writeDetail = duplicate ? "No rows written — this capture was already applied."
    : probe.run ? "Rows were written by the run that already landed."
    : failed ? "No agent rows written; capture is in the review queue."
    : null;
  onStage?.(stage("writing", writeDetail ? { detail: writeDetail } : {}), 5);
  onStage?.(stage("done", duplicate || probe.run ? { detail: "Tables refreshed — nothing duplicated." } : {}), 6);

  return {
    ingestion,
    mediaAssets,
    agentResp,
    dedupe: dedupeResult,
    duplicate,
    // The run the server had already completed for this ingestion, found after a
    // failed invoke. Null means "no such run", not "no run happened elsewhere".
    recoveredRun: probe.run,
    // Hand back to a caller that wants to retry: reuse this, do not mint a new row.
    retryIngestionId: ingestion.id,
  };
}

export async function retryCapture(input, { ingestionId, onStage } = {}) {
  if (!ingestionId) throw new Error("retryCapture requires the original ingestionId — a retry must never mint a new capture row");
  return runCapture(input, { onStage, ingestionId });
}

async function loadIngestion(supabase, id) {
  const { data, error } = await supabase.from("raw_ingestions").select("*").eq("id", id).maybeSingle();
  if (error) throw error; // a failed read must reach the user, not fall back to a new row
  if (!data) throw new Error(`retry_ingestion_missing: ${id}`);
  return data;
}

async function loadMediaAssets(supabase, ingestionId) {
  const { data, error } = await supabase
    .from("media_assets").select("id, media_kind, storage_path").eq("ingestion_id", ingestionId);
  if (error) throw error;
  return data || [];
}

// Polls ai_runs for this ingestion. Returns { run, actionCount, error }: `run`
// null with a non-null `error` means UNKNOWN, not "nothing was written".
async function findRunForIngestion(supabase, ingestionId, { tries = RUN_POLL_TRIES, delayMs = RUN_POLL_MS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await delay(delayMs);
    const { data, error } = await supabase
      .from("ai_runs")
      .select("id, status, created_at")
      .eq("ingestion_id", ingestionId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) { lastError = error; continue; }
    if (data?.length) {
      const run = data[0];
      const { count, error: countErr } = await supabase
        .from("ai_actions")
        .select("id", { count: "exact", head: true })
        .eq("ai_run_id", run.id);
      if (countErr) console.error("[agent-runner] recovered run found, action count unavailable:", countErr);
      // null, never 0 — an unknown count must not render as "wrote nothing".
      return { run, actionCount: countErr ? null : (count ?? null), error: null };
    }
  }
  if (lastError) console.error("[agent-runner] could not verify whether a run landed:", lastError);
  return { run: null, actionCount: null, error: lastError };
}

async function runLocalCapture({ text, files, captureType, transcript, sourceType }, { onStage } = {}) {
  const combinedText = [text, transcript].filter(Boolean).join("\n").trim();
  const localStages = [
    stage("queued", { detail: "Local capture received." }),
    stage("uploading", { detail: "Saved in this browser session." }),
    stage("extracting", { detail: files.length ? `${files.length} file hint(s) prepared.` : "Text input only." }),
    stage("reasoning", { detail: "Running local parser fallback." }),
    stage("dedupe", { detail: "Flagging possible duplicates for review." }),
    stage("writing", { detail: "Writing local rows." }),
    stage("done", { detail: "Local tables refreshed." }),
  ];

  for (const [index, item] of localStages.entries()) {
    onStage?.(item, index);
    await delay(index === 0 ? 0 : 180);
  }

  const updates = parseCapture({
    text: combinedText,
    files: files.map((file) => ({ name: file.name, type: file.type, kind: pickKind(file) })),
    captureType,
  });

  updateState((state) => {
    state.reviewRows = [...updates.reviewRows, ...state.reviewRows];
    state.ledgerRows = [...updates.ledgerRows, ...state.ledgerRows];
    state.importRows = [...updates.importRows, ...state.importRows];
    state.macroRows = [...updates.macroRows, ...state.macroRows];
    state.insights = [...updates.insights, ...state.insights].slice(0, 12);
    state.metrics.todaySpend += updates.metricsDelta.spend;
    state.metrics.protein = Math.min(state.metrics.proteinTarget + 35, state.metrics.protein + updates.metricsDelta.protein);
    state.metrics.caloriesLeft = Math.max(0, state.metrics.caloriesLeft - updates.metricsDelta.calories);
    state.metrics.habitScore = Math.max(0, Math.min(100, state.metrics.habitScore + updates.metricsDelta.habit));
    state.metrics.adherence = Math.max(0, Math.min(100, state.metrics.adherence + updates.metricsDelta.adherence));
    state.metrics.habitNote = updates.metricsDelta.habit < 0 ? "Sleep recovery needs attention" : "Fresh local capture applied";
  });

  return { local: true, sourceType, updates };
}

function delay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
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
