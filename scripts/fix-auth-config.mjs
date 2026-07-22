// Repairs the Supabase Auth config that made sign-in impossible.
//
// The project shipped with site_url = http://localhost:3000 and an EMPTY redirect
// allow-list, so every magic link / password-reset email pointed at a dev server
// that does not exist, and any redirectTo the app asked for was rejected and
// silently downgraded to that localhost URL. This sets the real Pages origin plus
// the local dev origins.
//
// Usage: node scripts/fix-auth-config.mjs [--dry]
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const PAT = process.env.SUPABASE_PAT || process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!PAT || !REF) {
  console.error("SUPABASE_PAT and SUPABASE_PROJECT_REF must be set in .env.local");
  process.exit(2);
}

const SITE_URL = "https://ubhayaab.github.io/trackerz/";
const ALLOW = [
  "https://ubhayaab.github.io/trackerz/**",
  "https://ubhayaab.github.io/trackerz",
  "http://127.0.0.1:4173/**",
  "http://localhost:4173/**",
];

const desired = {
  site_url: SITE_URL,
  uri_allow_list: ALLOW.join(","),
  // Password reset / magic-link codes stay valid long enough to open on a phone.
  mailer_otp_exp: 3600,
};

const base = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const headers = { Authorization: `Bearer ${PAT}`, "content-type": "application/json" };

const before = await (await fetch(base, { headers })).json();
console.log("before:", JSON.stringify({ site_url: before.site_url, uri_allow_list: before.uri_allow_list }));

if (process.argv.includes("--dry")) {
  console.log("would set:", JSON.stringify(desired, null, 2));
  process.exit(0);
}

const res = await fetch(base, { method: "PATCH", headers, body: JSON.stringify(desired) });
if (!res.ok) {
  console.error("PATCH failed", res.status, await res.text());
  process.exit(1);
}

const after = await (await fetch(base, { headers })).json();
console.log("after: ", JSON.stringify({ site_url: after.site_url, uri_allow_list: after.uri_allow_list }));
console.log("done.");
