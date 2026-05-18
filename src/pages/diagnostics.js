import { bootWithAuth } from "./bootstrap.js";
import { getSupabaseClient } from "../services/supabase-client.js";
import { getCurrentSession } from "../services/auth.js";
import { isLiveTranscriptionSupported } from "../services/speech.js";
import { hasSupabaseConfig } from "../config.js";
import { runCapture } from "../services/agent-runner.js";

bootWithAuth(async () => {
  await runChecks();
  document.getElementById("diagRunBtn").addEventListener("click", runChecks);
  document.getElementById("diagE2EBtn").addEventListener("click", runE2E);
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
