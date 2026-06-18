# Deploy the agent edge function (one-time, ~30 seconds)

The DB, schema, RLS, buckets, Gemini key — all already set up. The only thing
that can't be automated without a Personal Access Token is the actual edge
function code upload. Here's the literal click path.

---

## ⚡ UPDATE — do these 3 things to turn on the DeepSeek brain + new features

This build switched the pipeline to **Gemini for image/voice extraction → DeepSeek
for the reasoning/tool-calls (the "brain")**, added a `workout_logs` table, and
made `schema.sql` the single source of truth. To activate it on your live site:

### 1. Add the DeepSeek API key (the brain)

Get a key from <https://platform.deepseek.com/api_keys>, then **either**:

- **CLI:** `supabase secrets set DEEPSEEK_API_KEY=sk-... GEMINI_API_KEY=...`
  (the repo's `scripts/set-supabase-secrets.ps1` also picks up `$env:DEEPSEEK_API_KEY`), **or**
- **SQL editor** (same place the Gemini key lives):
  ```sql
  insert into public.app_secrets (name, value) values ('DEEPSEEK_API_KEY', 'sk-...')
  on conflict (name) do update set value = excluded.value;
  ```

Gemini stays required (it does the image OCR / voice transcription / food-photo
vision). DeepSeek is the new reasoning brain. If DeepSeek is unset/down, the
function automatically falls back to Gemini for reasoning too.

### 2. Apply the DB changes

In the SQL editor, run the new migration (and, on a fresh project, `schema.sql`
alone is now complete):
```
supabase/migrations/20260524000005_workout_logs.sql
```
Or just `supabase db push` if you use the CLI. `schema.sql` now also contains
every table that previously lived only in migrations.

### 3. Re-deploy the `agent` function

Paste the updated `supabase/functions/agent/index.ts` (steps below) and Deploy.

### Connecting the frontend to your backend

The app resolves Supabase URL + anon key from (1) `src/config.local.js`,
(2) `localStorage`, or (3) the on-screen setup card. On the live Pages site the
publishable config is already baked in, so signing in just works. The anon key is
safe in the browser because RLS is on every user table.

---

## Steps

1. Open **Edge Functions** in Studio:
   <https://supabase.com/dashboard/project/yyoewdcijplkhxleejtm/functions>

2. Click **Create a new function**. Name it exactly: `agent`

3. Open `supabase/functions/agent/index.ts` from this repo in your editor.
   Select all (Ctrl+A), copy.

4. Paste into the Studio editor, replacing the default template.

5. Click **Deploy function**.

That's it. The function reads `GEMINI_API_KEY` from `public.app_secrets`
(already inserted) so you don't need to set any function secret.

## When you change the function code later

Repeat steps 1, 3, 4, 5. Or just paste into the existing function and click
Deploy again.

## OAuth providers (optional, takes a minute)

Magic-link sign-in already works. To enable Google / GitHub buttons:

<https://supabase.com/dashboard/project/yyoewdcijplkhxleejtm/auth/providers>

- **Google**: toggle on, paste your OAuth client ID + secret from
  <https://console.cloud.google.com/apis/credentials>. Authorized redirect:
  `https://yyoewdcijplkhxleejtm.supabase.co/auth/v1/callback`.
- **GitHub**: toggle on, paste OAuth app from
  <https://github.com/settings/developers>. Same callback URL.

## How the secret resolution works (so it's not magic)

`resolveSecret(name)` in `supabase/functions/agent/index.ts`:

1. `Deno.env.get(name)` — function secret set via Studio or `supabase secrets set`
2. If empty → `select value from app_secrets where name = $1` using
   `SUPABASE_SERVICE_ROLE_KEY` (auto-injected by the Supabase runtime)
3. Cached for the lifetime of the function instance

So if you ever generate a PAT and want to graduate to "real" secrets, just
`supabase secrets set GEMINI_API_KEY=...` and the env path takes precedence.
Nothing else changes.
