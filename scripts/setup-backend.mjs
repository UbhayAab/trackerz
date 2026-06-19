// One-shot backend setup. Zero dependencies (Node 18+ built-in fetch).
//
// Does EVERYTHING the live site needs, via the Supabase Management API:
//   1. Applies schema.sql + every migration (creates workout_logs, folds tables).
//   2. Stores DEEPSEEK_API_KEY / GEMINI_API_KEY into public.app_secrets (the
//      edge function reads these), and also as function secrets if possible.
//   3. Deploys the `agent` edge function (best-effort; prints a fallback if the
//      API rejects the bundle).
//
// You must supply ONE secret you own — a Supabase personal access token with
// project access (https://supabase.com/dashboard/account/tokens):
//
//   PowerShell:
//     $env:SUPABASE_ACCESS_TOKEN="sbp_..."; $env:DEEPSEEK_API_KEY="sk-..."; node scripts/setup-backend.mjs
//   bash:
//     SUPABASE_ACCESS_TOKEN=sbp_... DEEPSEEK_API_KEY=sk-... node scripts/setup-backend.mjs
//
// DEEPSEEK_API_KEY is OPTIONAL — without it the agent automatically falls back
// to Gemini for reasoning. GEMINI_API_KEY is usually already set on the project.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.supabase.com";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || "qmlenovxatoyxxqlvzlo";

// Any of these, if set in the environment, get stored as backend secrets.
// GEMINI_API_KEY  -> image/voice extraction (required for media captures).
// DEEPSEEK_API_KEY OR NVIDIA_API_KEY -> the reasoning brain (optional; Gemini
//   reasoning is the fallback). For NVIDIA-hosted DeepSeek also set:
// DEEPSEEK_BASE_URL=https://integrate.api.nvidia.com/v1/chat/completions
// DEEPSEEK_MODEL=deepseek-ai/deepseek-v3.1
const SECRET_ENV = ["GEMINI_API_KEY", "DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"];

if (!TOKEN) {
  console.error("ERROR: set SUPABASE_ACCESS_TOKEN to a PERSONAL ACCESS TOKEN (starts with `sbp_`,");
  console.error("       create at https://supabase.com/dashboard/account/tokens).");
  console.error("       NOTE: the service_role key (sb_secret_...) does NOT work for the Management API.");
  process.exit(1);
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

// Lists projects the token can see and verifies REF is one of them. This is how
// you settle the qmlenovxatoyxxqlvzlo vs yyoewdcijplkhxleejtm confusion: deploy
// to the SAME project your frontend (src/config.js) points at.
async function verifyProject() {
  console.log(`0. Verifying project ${REF}…`);
  const res = await fetch(`${API}/v1/projects`, { headers: auth });
  if (!res.ok) throw new Error(`list projects: ${res.status} ${(await res.text()).slice(0, 200)} (is the token a valid PAT?)`);
  const projects = await res.json();
  for (const p of projects) console.log(`   · ${p.id}  ${p.name}  [${p.status}]`);
  if (!projects.some((p) => p.id === REF)) {
    throw new Error(`project ref "${REF}" is not in your account. Set SUPABASE_PROJECT_REF to one of the ids above (use the SAME one as src/config.js PROD_URL).`);
  }
  console.log(`  ✓ ${REF} found`);
}

async function runSql(label, sql) {
  const res = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST", headers: auth, body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`${label}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`  ✓ ${label}`);
}

async function applySchemaAndMigrations() {
  console.log("1. Applying schema + migrations (idempotent)…");
  await runSql("schema.sql", readFileSync(join(ROOT, "supabase/schema.sql"), "utf8"));
  const migDir = join(ROOT, "supabase/migrations");
  for (const file of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    await runSql(`migration ${file}`, readFileSync(join(migDir, file), "utf8"));
  }
}

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function setSecrets() {
  console.log("2. Storing API keys / brain config…");
  // app_secrets is the reliable path the edge function reads first via fallback.
  const rows = [];
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value) rows.push([name, value]);
  }
  if (!rows.length) { console.log("  · no keys provided (brain optional; Gemini likely already set)"); return; }
  const values = rows.map(([n, v]) => `(${sqlString(n)}, ${sqlString(v)})`).join(", ");
  await runSql(
    "app_secrets upsert",
    `insert into public.app_secrets (name, value) values ${values}
     on conflict (name) do update set value = excluded.value, updated_at = now();`,
  );
  // Also try real function secrets (env path takes precedence). Non-fatal.
  try {
    const res = await fetch(`${API}/v1/projects/${REF}/secrets`, {
      method: "POST", headers: auth,
      body: JSON.stringify(rows.map(([name, value]) => ({ name, value }))),
    });
    console.log(res.ok ? "  ✓ function secrets set" : `  · function-secrets API said ${res.status} (app_secrets still set; fine)`);
  } catch { console.log("  · function-secrets API unreachable (app_secrets still set; fine)"); }
}

async function deployFunction() {
  console.log("3. Deploying the `agent` edge function (best-effort)…");
  const body = readFileSync(join(ROOT, "supabase/functions/agent/index.ts"), "utf8");
  const payloads = [
    { method: "POST", url: `${API}/v1/projects/${REF}/functions?slug=agent`, body: JSON.stringify({ slug: "agent", name: "agent", body, verify_jwt: true }) },
    { method: "PATCH", url: `${API}/v1/projects/${REF}/functions/agent`, body: JSON.stringify({ body, verify_jwt: true }) },
  ];
  for (const p of payloads) {
    try {
      const res = await fetch(p.url, { method: p.method, headers: auth, body: p.body });
      if (res.ok) { console.log("  ✓ function deployed via Management API"); return true; }
    } catch { /* try next */ }
  }
  console.log("  · Management API would not accept the bundle (common — it wants an eszip).");
  console.log("    FALLBACK (30s): open Studio → Edge Functions → agent → paste");
  console.log("    supabase/functions/agent/index.ts → Deploy. OR: supabase functions deploy agent");
  return false;
}

console.log(`Trackerz backend setup → project ${REF}\n`);
try {
  await verifyProject();
  await applySchemaAndMigrations();
  await setSecrets();
  await deployFunction();
  console.log("\nDone. DB + keys are set. If the function step printed a FALLBACK, do that one paste and you're fully live.");
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  console.error("Check the token has access to the project and the project ref is correct.");
  process.exit(1);
}
