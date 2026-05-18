# Trackerz

A capture-first life tracker: voice notes, screenshots, bank statements → unified spend/diet/wellness ledger with smart dedupe and Nifty 50 opportunity-cost insights.

Hosted on GitHub Pages. Auth + DB on Supabase. AI brain via Gemini 2.5 Flash (in the Supabase Edge Function).

## First-time setup on your phone

1. Open the GitHub Pages URL (printed in the Actions workflow).
2. You'll see a one-time setup card. Paste:
   - **Supabase URL**: `https://qmlenovxatoyxxqlvzlo.supabase.co` (pre-filled)
   - **Supabase anon key**: grab from Supabase dashboard → Project Settings → API → `anon public`
3. Tap **Save**. The setup card disappears.
4. A sign-in card appears. Enter your email, tap **Send magic link**.
5. Check your email on the phone, tap the link. You're in.
6. Open **Settings → Run diagnostics** to confirm every layer (auth, storage, edge function) is green.

If something says FAIL on the diagnostics page, that row tells you exactly what is wrong.

## Daily use

- **Capture tab**: type, paste, upload images, upload bank statement files, or hold the Record voice button.
- **Money tab**: see ledger, upload CSV/XLS/XLSX statement files (parsed in-browser), set monthly/weekly caps.
- **Diet tab**: meal log with macro estimates.
- **Insights tab**: AI summary + **Nifty 50 opportunity cost** ("what if you'd invested your discretionary spend instead").
- **Settings tab**: AI cap, nightly summary toggle, run diagnostics.

## Architecture

- **Frontend**: vanilla JS modules under `src/`, static HTML pages under `pages/` + `index.html`.
- **Auth**: Supabase magic link.
- **Storage**: Supabase Storage buckets `raw-media` (images/audio) and `statements` (CSV/XLS/PDF), per-user folder isolation via RLS.
- **DB**: Postgres schema in `supabase/schema.sql` with RLS on every user table.
- **Agent**: Supabase Edge Function `agent` calls Gemini 2.5 Flash with a strict JSON tool-call schema, persists `ai_runs` + `ai_actions`, and auto-applies high-confidence writes.
- **Dedupe**: client-side cross-source scanner that handles "Rs 250 said in voice vs Rs 252 in bank" with time-bucket + amount-tolerance matching.

## Free input fallbacks

- **Voice → text**: Web Speech API live in Chrome/Edge (zero cost). Audio file fallback transcribed by Gemini.
- **Image → text**: Gemini 2.5 Flash vision (generous free tier). Tesseract.js can be plugged in if you hit limits.
- **Statements**: parsed entirely in browser with SheetJS (`xlsx`), no server roundtrip.

## Key safety

- **Never** commit Gemini, NVIDIA, Supabase service-role keys. They live only in Supabase Edge Function secrets.
- The Supabase **anon key** is safe in the browser as long as RLS is enabled (it is).
- `src/config.local.js` is gitignored; alternatively the runtime setup card stores keys in localStorage.

## Local development

Serve the folder as static:

```powershell
node scripts/static-server.mjs
```

Run tests:

```powershell
node tests/agent-core.test.mjs
node tests/agent-policy.test.mjs
node tests/analytics-imports.test.mjs
node tests/architecture.test.mjs
node tests/capture-fixtures.test.mjs
node tests/dedupe-scan.test.mjs
node tests/flow-catalog.test.mjs
node tests/interaction-contract.test.mjs
node tests/opportunity-cost.test.mjs
node tests/ui-contract.test.mjs
```

## Supabase migrations

If you need to re-apply schema:

```powershell
# Initial schema
supabase db push --file supabase/schema.sql
# Or apply incremental migrations
supabase db push --file supabase/migrations/20260518000001_rls_and_buckets.sql
supabase db push --file supabase/migrations/20260518000002_discretionary_and_nifty.sql
```

## Edge function

The function lives at `supabase/functions/agent/index.ts`. To redeploy:

```powershell
supabase functions deploy agent
```

The function expects these secrets in Supabase:
- `GEMINI_API_KEY` (you set this)
- `SUPABASE_URL` (auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected)

`NVIDIA_API_KEY` from the old version is no longer needed.
