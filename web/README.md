# Trackerz — web (Next.js on Vercel)

The React/Next.js rewrite of Trackerz. Backend is unchanged: Supabase (Postgres +
Auth + RLS + Storage) and the Deno edge functions (`agent`, `nightly`,
`email-inbound`) in `../supabase`.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000
```

Prod Supabase creds are baked into `src/lib/config.ts`, so it works with no env.
To point at another project, copy `.env.example` → `.env.local`.

## Deploy (Vercel)

1. New Vercel project → import this repo.
2. **Root Directory: `web`** (important — the Next app is in a subfolder).
3. Framework preset: Next.js (auto). Build `next build`, output auto.
4. (Optional) set `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. Deploy → preview URL. Promote to production / add the domain at cutover.

No data migration: the DB + edge functions stay on Supabase; only the frontend
origin changes.

## Structure

```
src/
  app/            routes (App Router): /, /login, /money, /diet, /gym, /analytics, /settings
  components/     shell (nav, top bar, transitions), ui primitives, capture, home
  lib/            supabase client, config, services (capture + data), formatters
middleware.ts     Supabase session refresh + auth gate
```
