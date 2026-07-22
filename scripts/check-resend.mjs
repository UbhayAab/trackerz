// Diagnoses why Jarvis emails never arrive even though Resend returns 200.
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here — set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";

const c = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || FALLBACK).replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query(
  "select name, value from app_secrets where name in ('RESEND_API_KEY','JARVIS_EMAIL_FROM')"
);
await c.end();

const key = rows.find((r) => r.name === "RESEND_API_KEY")?.value;
const from = rows.find((r) => r.name === "JARVIS_EMAIL_FROM")?.value;
console.log("JARVIS_EMAIL_FROM:", from || "(unset -> falls back to onboarding@resend.dev)");

for (const path of ["domains", "emails?limit=15"]) {
  const res = await fetch(`https://api.resend.com/${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  console.log(`\n== GET /${path} -> ${res.status}`);
  console.log(text.slice(0, 2000));
}
