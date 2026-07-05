// Generate the Web Push VAPID keypair for the Jarvis engine.
//
// - Upserts the private+public JWK pair into public.app_secrets as
//   JARVIS_VAPID_JWK (the jarvis edge fn reads it via resolveSecret; the private
//   key is never printed).
// - Prints the base64url RAW public key — paste that into VAPID_PUBLIC_KEY in
//   src/services/push.js (it is public by design; browsers send it in the clear).
//
// Refusing to overwrite an existing key by default (rotating VAPID invalidates
// every existing push subscription): pass --force to rotate.
//
// Usage:  node scripts/generate-vapid-keys.mjs [--force]

import { webcrypto as crypto } from "node:crypto";
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });

const url = process.env.SUPABASE_DB_URL?.replace(/\?sslmode=require/, "");
if (!url) {
  console.error("SUPABASE_DB_URL missing in .env.local");
  process.exit(2);
}

const force = process.argv.includes("--force");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const existing = await client.query("select 1 from public.app_secrets where name = 'JARVIS_VAPID_JWK'");
if (existing.rowCount > 0 && !force) {
  console.log("JARVIS_VAPID_JWK already set — keeping it (rotating would orphan every push subscription).");
  console.log("Pass --force to rotate anyway.");
  await client.end();
  process.exit(0);
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const publicRawB64url = Buffer.from(raw).toString("base64url");

await client.query(
  `insert into public.app_secrets (name, value) values ($1, $2)
   on conflict (name) do update set value = excluded.value`,
  ["JARVIS_VAPID_JWK", JSON.stringify({ publicKey: publicJwk, privateKey: privateJwk })],
);
await client.end();

console.log("✓ JARVIS_VAPID_JWK saved to app_secrets (private key not shown)");
console.log("");
console.log("Public applicationServerKey (paste into src/services/push.js VAPID_PUBLIC_KEY):");
console.log(publicRawB64url);
