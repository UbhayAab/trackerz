// Generates a Web Push VAPID keypair (P-256, base64url — the exact format
// web-push / PushManager expect) and prints the SQL + CLI commands to install
// it. Run once, keep the private key secret (app_secrets / function secrets
// only — NEVER in client code or git).
//
//   node scripts/generate-vapid-keys.mjs
import { webcrypto } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const publicRaw = await webcrypto.subtle.exportKey("raw", pair.publicKey); // 65-byte uncompressed point
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

const publicKey = b64url(publicRaw);
const privateKey = privateJwk.d; // already base64url

console.log("VAPID keypair generated.\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`
-- Option A: app_secrets rows (the nightly fn reads these when env is unset):
insert into public.app_secrets (name, value) values
  ('VAPID_PUBLIC_KEY',  '${publicKey}'),
  ('VAPID_PRIVATE_KEY', '${privateKey}'),
  ('VAPID_SUBJECT',     'mailto:ubhayvatsaanand@gmail.com')
on conflict (name) do update set value = excluded.value;

# Option B: function secrets via the CLI:
supabase secrets set VAPID_PUBLIC_KEY=${publicKey} VAPID_PRIVATE_KEY=${privateKey} VAPID_SUBJECT=mailto:ubhayvatsaanand@gmail.com --project-ref yyoewdcijplkhxleejtm
`);
