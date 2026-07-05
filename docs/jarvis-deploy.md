# Jarvis proactive brain — deploy runbook (v18)

What shipped in this build:

1. **Nightly brain** — `supabase/functions/nightly`: pg_cron POSTs twice a day
   (7 AM + 8 PM IST); the function runs the SAME pure insight detectors +
   briefing composer as the app (byte-identical mirrors under
   `supabase/functions/_shared/`, enforced by `tests/nightly-parity.test.mjs`),
   writes a `briefings` row for every `briefing_enabled` user, and sends a real
   Web Push to every registered device — whether or not the app was opened.
2. **Web Push** — `push_subscriptions` table, `src/services/push.js`, SW `push`
   handlers, Settings toggles ("Push notifications", "Send test notification",
   "Run my briefing now").
3. **Paste-a-plan import** — pasting a full ChatGPT/coach gym or diet plan into
   the capture box now lands as ONE structured permanent plan (weekly
   `days:{Monday:…}` maps supported for both kinds; the gym hub finally honors a
   permanent gym plan).

The frontend + both edge functions deploy automatically on push to `main`
(Pages workflow + `deploy-functions.yml`, which now deploys `nightly` with
`--no-verify-jwt` — required because cron calls it with a shared secret, not a
JWT). **The steps below are the one-time manual pieces.**

## 1. Apply the migration (new table)

Run `supabase/migrations/20260705000015_push_subscriptions.sql` — either
`npm run db:push` from a machine with the DB URL in `.env.local`, or paste it
into the Studio SQL editor. It only creates `push_subscriptions` (+RLS+index);
re-running is safe.

## 2. Generate the VAPID keypair (once)

```powershell
node scripts/generate-vapid-keys.mjs
```

It prints ready-to-paste installs. Pick ONE:
- **app_secrets** (easiest): run the printed `insert into public.app_secrets …`
  in the SQL editor, or
- **function secrets**: run the printed `supabase secrets set …` command.

The public key is served to the browser by the function itself
(`{op:"vapid"}`) — nothing is baked into client code.

## 3. Set the cron shared secret (once)

```sql
insert into public.app_secrets (name, value)
values ('NIGHTLY_SECRET', '<any long random string>')
on conflict (name) do update set value = excluded.value;
```

## 4. Deploy the nightly function

Push to `main` does it (needs the `SUPABASE_ACCESS_TOKEN` repo secret). Manual
fallback from an unproxied machine:

```powershell
supabase functions deploy nightly --no-verify-jwt --project-ref yyoewdcijplkhxleejtm
```

`--no-verify-jwt` is required; without it the cron POST gets 401 before our
code runs. The function still verifies callers itself (secret header OR JWT).

## 5. THE SPIKE — prove a real push arrives (do this before trusting the rest)

Web-push encryption is the one unproven piece (npm:web-push inside Deno edge).
Prove it end-to-end in 2 minutes:

1. Open the live app → Settings → tick **Push notifications on this device**
   (grant the permission prompt). On iPhone: Share → **Add to Home Screen**
   first and do this inside the installed app — Safari tabs cannot receive push.
2. Tap **Send test notification**. A real OS notification must appear (also
   works with the browser closed on Android/desktop).
3. Tap **Run my briefing now** — generates + pushes today's actual briefing.

If step 2 errors: the settings line prints the push-service status code.
`vapid_not_configured` → step 2 above; a 5xx from the function → check
`supabase functions logs nightly` (if npm:web-push won't run under edge Deno,
the fallback is swapping it for the Deno-native `jsr:@negrel/webpush` — the
send call is isolated in `pushToUser()` so it's a one-function change).

## 6. Register the cron (after 2–5 pass)

Run `supabase/nightly-cron.sql` in the SQL editor. It enables pg_cron + pg_net
(already available on yyoe) and schedules:
- `trackerz-briefing-morning` — 01:30 UTC = 07:00 IST
- `trackerz-briefing-evening` — 14:30 UTC = 20:00 IST

The job reads `NIGHTLY_SECRET` from `app_secrets` at fire time — no secret is
inlined into the cron command.

Verify:

```sql
select jobid, jobname, schedule from cron.job;
-- after a fire time:
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, content from net._http_response order by created desc limit 5;
select kind, for_date, body from public.briefings order by created_at desc limit 5;
```

You can also fire it immediately without waiting for 7 AM:

```powershell
Invoke-RestMethod -Method Post -Uri "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/nightly" -Headers @{ "x-nightly-secret" = "<NIGHTLY_SECRET>" } -ContentType "application/json" -Body '{"slot":"evening"}'
```

## Known limitations (by design, worth remembering)

- **iOS**: push only reaches a PWA installed to the Home Screen (iOS 16.4+).
- The cron fires at fixed IST times; per-user timezones are respected in the
  briefing CONTENT (wall-clock math), not the delivery hour.
- The nightly path is deliberately **model-free** (deterministic detectors +
  composer) — zero AI spend, nothing to hallucinate at 7 AM.
- If a mirror under `supabase/functions/_shared/` drifts from its `src/`/`lib/`
  source, `npm test` fails (`nightly-parity`) — fix by re-copying the file.
