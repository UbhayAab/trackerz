// One-shot deploy for an edge function via the Supabase Management API.
//
// What this does:
//   1. Reads SUPABASE_PROJECT_REF + SUPABASE_PAT (Personal Access Token) from .env.local.
//   2. Bundles supabase/functions/<slug>/index.ts as a single-file deployment.
//   3. Calls POST /v1/projects/{ref}/functions/deploy?slug=<slug>.
//   4. (Optional, agent only) If GEMINI_API_KEY is in .env.local, sets it as a function secret.
//
// verify_jwt per function: `agent` requires a user JWT; `jarvis` is deployed with
// verify_jwt=false because pg_cron calls it with the x-jarvis-secret header (auth
// is enforced in-function) and the new-style publishable keys are not JWTs.
//
// Requirements:
//   - SUPABASE_PAT in .env.local. Create one at
//       https://supabase.com/dashboard/account/tokens
//     and paste it as `SUPABASE_PAT=sbp_...`.
//   - GEMINI_API_KEY (optional): https://aistudio.google.com/apikey
//
// Run:
//   node scripts/deploy-edge-function.mjs [slug]   # default: agent

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const slug = process.argv[2] || "agent";
const VERIFY_JWT = { agent: true, jarvis: false };
if (!(slug in VERIFY_JWT)) bail(`Unknown function slug "${slug}" - add it to VERIFY_JWT in this script.`);

const ref = process.env.SUPABASE_PROJECT_REF;
const pat = process.env.SUPABASE_PAT;
const geminiKey = slug === "agent" ? process.env.GEMINI_API_KEY : null;

if (!ref) bail("SUPABASE_PROJECT_REF missing from .env.local");
if (!pat) bail("SUPABASE_PAT missing from .env.local - create one at https://supabase.com/dashboard/account/tokens");

const base = "https://api.supabase.com";
const auth = { Authorization: `Bearer ${pat}` };

async function deployFunction() {
  const filePath = resolve(`supabase/functions/${slug}/index.ts`);
  const code = await readFile(filePath, "utf8");

  const meta = {
    name: slug,
    verify_jwt: VERIFY_JWT[slug],
    entrypoint_path: "index.ts",
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  form.append("file", new Blob([code], { type: "application/typescript" }), "index.ts");

  const res = await fetch(`${base}/v1/projects/${ref}/functions/deploy?slug=${slug}`, {
    method: "POST",
    headers: auth,
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    bail(`Deploy failed: HTTP ${res.status}\n${body}`);
  }
  const data = await res.json().catch(() => ({}));
  console.log(`✓ deployed ${slug} function (version ${data?.version ?? "?"})`);
}

async function setSecret(name, value) {
  const res = await fetch(`${base}/v1/projects/${ref}/secrets`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ name, value }]),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`✗ secret ${name} failed: HTTP ${res.status}\n${body}`);
    return false;
  }
  console.log(`✓ set secret ${name}`);
  return true;
}

await deployFunction();

if (geminiKey) {
  await setSecret("GEMINI_API_KEY", geminiKey);
} else if (slug === "agent") {
  console.warn("• GEMINI_API_KEY empty in .env.local - set it later or the function will return 500 on every call.");
}

function bail(msg) {
  console.error(msg);
  process.exit(2);
}
