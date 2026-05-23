// Quick audit: list tables, RLS state, storage buckets in the live Supabase project.
// Run: node scripts/db-audit.mjs

import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });

const raw = process.env.SUPABASE_DB_URL;
if (!raw) {
  console.error("SUPABASE_DB_URL missing");
  process.exit(2);
}
const url = raw.replace(/\?sslmode=require/, "");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const tables = await client.query(`
  select c.relname as name,
         c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname
`);

console.log(`\nPublic tables (${tables.rows.length}):`);
for (const r of tables.rows) {
  console.log(`  ${r.rls_enabled ? "[RLS]" : "[----]"} ${r.name}`);
}

const buckets = await client.query(`select id, public from storage.buckets order by id`);
console.log(`\nStorage buckets (${buckets.rows.length}):`);
for (const b of buckets.rows) console.log(`  ${b.id} (public=${b.public})`);

const fns = await client.query(`
  select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
  order by p.proname
`);
console.log(`\nPublic functions (${fns.rows.length}):`);
for (const f of fns.rows) console.log(`  ${f.proname}`);

await client.end();
