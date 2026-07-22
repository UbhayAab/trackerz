// Sends one real test email through the exact path Jarvis uses, and prints
// Resend's raw response - the only way to tell "accepted" from "delivered".
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });
// Pooler fallback for when the direct db.* host is IPv6-only and fails to
// resolve. Never inline the password here - set SUPABASE_DB_URL_POOLER in
// .env.local (gitignored) alongside SUPABASE_DB_URL.
const FALLBACK = process.env.SUPABASE_DB_URL_POOLER || "";
const to = process.argv[2];
if (!to) { console.error("usage: node scripts/test-email.mjs <recipient>"); process.exit(2); }

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
const from = rows.find((r) => r.name === "JARVIS_EMAIL_FROM")?.value || "Jarvis <onboarding@resend.dev>";

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({
    from,
    to,
    subject: "Trackerz - Jarvis delivery test",
    text: "If you are reading this, Jarvis email delivery works. Reply is not monitored.",
  }),
});
console.log("from:", from);
console.log("to:  ", to);
console.log("status:", res.status);
console.log(await res.text());
