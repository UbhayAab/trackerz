import { bootWithAuth } from "./bootstrap.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession } from "../services/auth.js";
import { isLiveTranscriptionSupported } from "../services/speech.js";
import { hasSupabaseConfig } from "../config.js";
import { runCapture } from "../services/agent-runner.js";
import { renderNav } from "../ui/navigation.js";

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
      name: "Supabase config present",
      run: () => (hasSupabaseConfig()
        ? ok()
        : fail("no Supabase URL + anon key from config.local.js, localStorage, or built-in defaults")),
    },
    {
      name: "Auth session active",
      run: () => (getCurrentSession() ? ok() : fail("no active session")),
    },
    {
      name: "Web Speech (Chrome only)",
      run: () => (isLiveTranscriptionSupported()
        ? ok()
        : warn("no SpeechRecognition in this browser - voice capture falls back to upload")),
    },
    { name: "Supabase reachable", run: pingSupabase },
    { name: "Profile row exists", run: profileExists },
    { name: "Read ledger_entries", run: readLedger },
    { name: "Read food_logs", run: readFoodLogs },
    { name: "Read storage bucket", run: readBucket },
    { name: "Edge function 'agent' reachable", run: pingEdgeFn },
  ];

  const list = document.getElementById("diagList");
  list.innerHTML = checks
    .map((c, i) => `<div class="diag-row" data-i="${i}"><span>${c.name}</span><span class="diag-status">…</span></div>`)
    .join("");

  try {
    for (let i = 0; i < checks.length; i++) {
      const cell = list.querySelector(`[data-i="${i}"] .diag-status`);
      cell.textContent = "running";
      cell.className = "diag-status";
      let result;
      try {
        result = normalize(await checks[i].run());
      } catch (err) {
        result = fail(await describeError(err));
      }
      paint(cell, result);
    }
  } finally {
    running = false;
    btn.disabled = false;
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

/**
 * Supabase reports failures as plain objects, not Errors: PostgrestError carries
 * code/details/hint, StorageError carries a status, and FunctionsHttpError hides
 * the real reason in a Response body. Flattening all of it is the difference
 * between an actionable row and "[object Object]".
 */
async function describeError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.code) parts.push(`code ${err.code}`);
  if (err.status || err.context?.status) parts.push(`http ${err.status || err.context.status}`);
  if (err.details) parts.push(String(err.details));
  if (err.hint) parts.push(`hint: ${err.hint}`);
  const body = await readErrorBody(err);
  if (body) parts.push(body);
  if (!parts.length) parts.push(stringifyUnknown(err));
  return parts.join(" - ");
}

async function readErrorBody(err) {
  const ctx = err.context;
  if (!ctx || typeof ctx.text !== "function") return "";
  try {
    const text = (await ctx.text()).trim();
    return text.slice(0, 300);
  } catch {
    return ""; // body already consumed or not readable; the rest of the detail still stands
  }
}

function stringifyUnknown(err) {
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // fall through to String()
  }
  return String(err);
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
