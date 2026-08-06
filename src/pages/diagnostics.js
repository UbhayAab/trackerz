import { bootWithAuth } from "./bootstrap.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession } from "../services/auth.js";
import { isLiveTranscriptionSupported } from "../services/speech.js";
import { hasSupabaseConfig } from "../config.js";
import { runCapture } from "../services/agent-runner.js";
import { renderNav } from "../ui/navigation.js";
// describeError used to live in this file and was the only correct error
// flattener in the app - it is the one place that unwraps a FunctionsHttpError's
// Response body instead of printing "[object Object]". It now lives in
// lib/failure.mjs so every surface gets the same quality, and diagnostics
// imports it rather than keeping a private copy that can drift.
import { describeError, Ok, Err, classify } from "../../lib/failure.mjs";
import { renderDegradedBanner } from "../ui/degraded-banner.js";

bootWithAuth(async () => {
  renderNav();
  document.getElementById("diagRunBtn").addEventListener("click", runChecks);
  document.getElementById("diagE2EBtn").addEventListener("click", runE2E);
  await runChecks();
});

// Every check resolves to one of these. A check that succeeds with something
// worth reporting (a row sample, a rejection reason) still has to score green -
// scoring a detail string as failure is what made this page lie.
const ok = (detail = "") => ({ status: "ok", detail });
const warn = (detail) => ({ status: "warn", detail });
const fail = (detail) => ({ status: "fail", detail });

let running = false;

async function runChecks() {
  if (running) return;
  running = true;
  const btn = document.getElementById("diagRunBtn");
  btn.disabled = true;

  const checks = [
    {
      source: "your Supabase config",
      name: "Supabase config present",
      run: () => (hasSupabaseConfig()
        ? ok()
        : fail("no Supabase URL + anon key from config.local.js, localStorage, or built-in defaults")),
    },
    {
      source: "your sign-in",
      name: "Auth session active",
      run: () => (getCurrentSession() ? ok() : fail("no active session")),
    },
    {
      source: "voice capture",
      name: "Web Speech (Chrome only)",
      run: () => (isLiveTranscriptionSupported()
        ? ok()
        : warn("no SpeechRecognition in this browser - voice capture falls back to upload")),
    },
    { source: "the database", name: "Supabase reachable", run: pingSupabase },
    { source: "your profile", name: "Profile row exists", run: profileExists },
    { source: "money", name: "Read ledger_entries", run: readLedger },
    { source: "diet", name: "Read food_logs", run: readFoodLogs },
    { source: "uploaded media", name: "Read storage bucket", run: readBucket },
    { source: "the AI agent", name: "Edge function 'agent' reachable", run: pingEdgeFn },
  ];

  const list = document.getElementById("diagList");
  list.innerHTML = checks
    .map((c, i) => `<div class="diag-row" data-i="${i}"><span>${c.name}</span><span class="diag-status">…</span></div>`)
    .join("");

  // Each check is ALSO recorded as an Ok()/Err() result so the degraded banner
  // can name what is broken in one sentence at the top of the page. The row list
  // below already says it per line, but a reader who has to scan nine rows to
  // learn that money and diet are unreadable is being made to do the app's job.
  const results = [];

  try {
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i];
      const cell = list.querySelector(`[data-i="${i}"] .diag-status`);
      cell.textContent = "running";
      cell.className = "diag-status";
      let result;
      let thrown = null;
      try {
        result = normalize(await check.run());
      } catch (err) {
        thrown = err;
        result = fail(await describeError(err));
      }
      // A WARN is a working source with a caveat (no SpeechRecognition in this
      // browser), so it must not be reported as unloadable. Only a FAIL is.
      results.push(result.status === "fail"
        ? Err(thrown ? classify(thrown) : "unknown", thrown || result.detail, { source: check.source })
        : Ok(result.status, { source: check.source }));
      paint(cell, result);
    }
  } finally {
    running = false;
    btn.disabled = false;
    renderDegradedBanner(results, { onRetry: runChecks, root: document.querySelector("main") });
  }
}

function normalize(result) {
  if (result && typeof result === "object" && result.status) return result;
  // Defensive: a check that returns a bare boolean still has to score correctly.
  return result === true ? ok() : fail(String(result ?? "check returned no result"));
}

function paint(cell, { status, detail }) {
  const label = status === "ok" ? "OK" : status === "warn" ? "WARN" : "FAIL";
  const text = detail ? `${label} - ${detail}` : label;
  cell.textContent = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  cell.title = text; // full error survives the visual truncation
  cell.className = `diag-status ${status}`;
}

async function pingSupabase() {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("profiles").select("id").limit(1);
  if (error) throw error;
  return ok();
}

async function profileExists() {
  const supabase = await getSupabaseClient();
  const session = getCurrentSession();
  if (!session) return warn("not signed in - cannot check");
  const { data, error } = await supabase.from("profiles").select("id").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  return data ? ok() : fail("no profiles row for this user id");
}

async function readLedger() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.from("ledger_entries").select("id").limit(1);
  if (error) throw error;
  return ok(sampleNote(data));
}

async function readFoodLogs() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.from("food_logs").select("id").limit(1);
  if (error) throw error;
  return ok(sampleNote(data));
}

async function readBucket() {
  const supabase = await getSupabaseClient();
  const session = getCurrentSession();
  if (!session) return warn("not signed in - cannot check");
  const { data, error } = await supabase.storage.from("raw-media").list(session.user.id, { limit: 1 });
  if (error) throw error;
  return ok(Array.isArray(data) ? `${data.length} object sample` : "read succeeded, object count not reported");
}

// A zero-row read is a successful read, not a missing number - say so plainly.
function sampleNote(data) {
  return Array.isArray(data) ? `${data.length} row sample (limit 1)` : "read succeeded, row count not reported";
}

async function pingEdgeFn() {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.functions.invoke("agent", {
    body: { ingestionId: "00000000-0000-0000-0000-000000000000", userId: "00000000-0000-0000-0000-000000000000", sourceType: "text", text: "ping" },
  });
  if (!error) return ok();
  const detail = await describeError(error);
  // A 401/403 still proves the function is deployed and answering; the dummy
  // payload is expected to be rejected, so this is not a backend outage.
  if (/\b(401|403)\b/.test(detail)) return warn(`${detail} (reachable, request rejected)`);
  return fail(detail);
}

async function runE2E() {
  const out = document.getElementById("diagE2EOutput");
  const btn = document.getElementById("diagE2EBtn");
  btn.disabled = true;
  out.textContent = "Running...";
  try {
    const r = await runCapture(
      { text: `Diagnostics test paid 99 to TestMerchant on ${new Date().toISOString()}`, files: [], captureType: "money", transcript: "" },
      { onStage: (s) => { out.textContent += `\n${s.label}: ${s.detail}`; } },
    );
    out.textContent += `\n\nResult: ${JSON.stringify({
      ingestionId: r.ingestion?.id ?? "not reported",
      toolCalls: Array.isArray(r.agentResp?.toolCalls) ? r.agentResp.toolCalls.length : "not reported",
      dedupePairs: r.dedupe?.pairs ?? "not reported",
    }, null, 2)}`;
  } catch (err) {
    out.textContent += `\n\nFAIL: ${await describeError(err)}`;
  } finally {
    btn.disabled = false;
  }
}
