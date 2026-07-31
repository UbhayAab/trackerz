// One way to reach the live Postgres, used by every script that needs it.
//
// The direct `db.<ref>.supabase.co` host is IPv6-only on this project and
// intermittently fails to resolve from this machine (getaddrinfo ENOTFOUND),
// so a connection has to fall back to the session pooler. scripts/q.mjs has
// always done that; the scripts added later did not, and they worked right up
// until the moment DNS blinked. Rather than copy the fallback around, it lives
// here.
//
// Set both in .env.local (gitignored):
//   SUPABASE_DB_URL         direct  postgresql://...@db.<ref>.supabase.co:5432/postgres
//   SUPABASE_DB_URL_POOLER  pooler  postgresql://...@aws-...pooler.supabase.com:5432/postgres
import pg from "pg";

function client(url) {
  return new pg.Client({
    // A trailing ?sslmode=... overrides the ssl object below and then
    // Supabase's certificate chain fails verification.
    connectionString: String(url).replace(/\?.*$/, ""),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
  });
}

/** Connect to the live DB, trying the direct host then the pooler. */
export async function connectDb() {
  const direct = process.env.SUPABASE_DB_URL || "";
  const pooler = process.env.SUPABASE_DB_URL_POOLER || "";
  const tried = [];
  for (const url of [direct, pooler].filter(Boolean)) {
    const c = client(url);
    try {
      await c.connect();
      return c;
    } catch (err) {
      tried.push(`${url.includes("pooler") ? "pooler" : "direct"}: ${err.code || err.message}`);
      try { await c.end(); } catch { /* already dead */ }
    }
  }
  throw new Error(
    tried.length
      ? `could not reach the database (${tried.join("; ")})`
      : "no SUPABASE_DB_URL or SUPABASE_DB_URL_POOLER in .env.local",
  );
}
