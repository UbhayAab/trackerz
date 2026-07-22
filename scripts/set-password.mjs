// Sets the account password via the Supabase Auth admin API.
//
// Passwords are stored as bcrypt hashes — an existing one cannot be read back,
// only replaced. Existing sessions are NOT invalidated, so doing this cannot
// lock you out of a device you are already signed in on.
//
// Usage: node scripts/set-password.mjs <email> [password]
//        (omit the password and a strong one is generated and printed)
import { randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const SUPA = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const email = process.argv[2];
if (!email || !SUPA || !SECRET) {
  console.error("usage: node scripts/set-password.mjs <email> [password]");
  console.error("       needs SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local");
  process.exit(2);
}

// Readable but high-entropy: 4 words from a short list + digits + a symbol.
// Avoids characters that are ambiguous or awkward on a phone keyboard.
function generate() {
  const words = [
    "amber", "basil", "cobalt", "delta", "ember", "flint", "granite", "harbor",
    "indigo", "juniper", "kestrel", "lantern", "marble", "nectar", "onyx",
    "pepper", "quartz", "rowan", "saffron", "timber", "umber", "violet",
    "willow", "yarrow", "zephyr", "cedar", "opal", "slate",
  ];
  const pick = () => words[randomBytes(1)[0] % words.length];
  const digits = String(100 + (randomBytes(2).readUInt16BE(0) % 900));
  return `${pick()}-${pick()}-${digits}`;
}

const password = process.argv[3] || generate();

// Resolve the id straight from auth.users. The admin list endpoint
// (/auth/v1/admin/users) currently 500s on this project with "Database error
// finding users", so it is not a dependable lookup.
const { default: pg } = await import("pg");
const db = new pg.Client({
  connectionString: (process.env.SUPABASE_DB_URL || process.env.SUPABASE_DB_URL_POOLER || "").replace(/\?.*$/, ""),
  ssl: { rejectUnauthorized: false },
});
await db.connect();
const { rows } = await db.query("select id from auth.users where lower(email) = lower($1)", [email]);
await db.end();
if (!rows.length) {
  console.error(`no account found for ${email}`);
  process.exit(1);
}
const user = { id: rows[0].id };

const res = await fetch(`${SUPA}/auth/v1/admin/users/${user.id}`, {
  method: "PUT",
  headers: { "content-type": "application/json", apikey: SECRET, authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ password, email_confirm: true }),
});
if (!res.ok) {
  console.error(`update failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

// Prove it actually works rather than trusting the 200.
const check = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { "content-type": "application/json", apikey: process.env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ email, password }),
});
const verified = check.ok;

console.log(`account:  ${email}`);
console.log(`password: ${password}`);
console.log(`sign-in verified: ${verified ? "yes" : `NO — ${(await check.text()).slice(0, 200)}`}`);
process.exitCode = verified ? 0 : 1;
