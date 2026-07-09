# Live audit & fixes — run this on your personal laptop (has creds)

This is the runbook for the work that needs the live **yyoe** database
(`yyoewdcijplkhxleejtm`). It answers the three questions from the session —
*what did I log, what did the engine do with it, what is the summary saying* —
then fixes the damage from the gym-negation bug, ships the code fix, and turns
on the proactive machine.

Nothing here contains a secret. Keep your `sbp_` PAT / DB URL in your existing
local file; the commands below just reference them.

---

## 0. Pick an access method

| # | Method | When |
|---|--------|------|
| **A** | **Supabase Studio SQL editor** — `https://supabase.com/dashboard/project/yyoewdcijplkhxleejtm/sql/new` | Easiest. Runs as `postgres` (RLS bypassed, you see all rows). Use this for the whole audit + cleanup. |
| **B** | **Management API** via PowerShell + PAT | Scriptable. `Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/yyoewdcijplkhxleejtm/database/query" -Headers @{Authorization="Bearer $env:SB_PAT"} -ContentType "application/json" -Body (@{query=$sql} | ConvertTo-Json)` |
| **C** | **supabase CLI + pooler** | Fallback. `supabase db query --db-url "postgresql://postgres.yyoewdcijplkhxleejtm:<DB_PW>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres" "<SQL>"` |

> This is (almost certainly) a single-user app. All queries below are
> unscoped. If you ever added a second account, append
> `where user_id = '<your-profile-uuid>'` — get the uuid with
> `select id, email from public.profiles;`.

---

## Part A — Audit: what did I log, and what did the engine do?

The capture spine is: **`raw_ingestions`** (what you dropped in) →
**`ai_runs`** (each model call) → **`ai_actions`** (the tool calls the brain
emitted, and whether they were auto-applied / sent to review / blocked) → the
domain row (`workout_logs`, `food_logs`, `ledger_entries`, …).

### A1. Your last 25 captures

```sql
select created_at, source_type, status, left(raw_text, 120) as text
from public.raw_ingestions
order by created_at desc
limit 25;
```

### A2. Each capture joined to what the engine decided

One row per emitted tool call, newest first — read it as
"capture X → run Y (model) → emitted tool Z at confidence C, status S, wrote
table/id".

```sql
select ri.created_at,
       left(ri.raw_text, 80)              as capture,
       run.provider, run.model, run.status as run_status,
       act.tool_name,
       act.confidence,
       act.status                          as action_status,   -- auto_applied | needs_review | blocked | proposed
       act.applied_record_table,
       act.arguments ->> 'description'      as description
from public.raw_ingestions ri
left join public.ai_runs   run on run.ingestion_id = ri.id
left join public.ai_actions act on act.ingestion_id = ri.id
order by ri.created_at desc, act.created_at
limit 60;
```

### A3. The smoking gun — workouts logged from a "no-gym" note

These are the bogus rows the negation bug created. Any hit here is a day the
gym checklist got auto-ticked despite you saying you didn't go.

```sql
select id, occurred_at, left(description, 100) as description, created_at
from public.workout_logs
where description ~* '(did ?n''?t|do ?n''?t|couldn''?t|was ?n''?t|skip|missed|no gym|no workout|didn''t go|rest day|too tired|bailed)'
order by occurred_at desc;
```

### A4. What the summary / briefing is saying

The briefing is deterministic (no model) — it just reads your rows, so if it
claims gym is done on a skipped day it's faithfully echoing the bogus
`workout_logs` from A3. Fixing A3 (Part B) fixes the summary too.

```sql
select kind, for_date, seen, left(body, 300) as body, created_at
from public.briefings
order by for_date desc, created_at desc
limit 10;
```

> **If Part A4 returns zero rows**, the proactive machine has never run — go to
> **Part D**. (The summary you see in-app on Home is computed live in the
> browser from the same rows; the `briefings` table is only populated by the
> nightly cron.)

---

## Part B — Undo the damage: un-tick the bad gym days  ⚠️ destructive

The gym checklist ticks a day when **any** `workout_logs` row exists for that
day (presence = done). So deleting the bogus "no-gym" rows un-ticks those days.
This deletes real DB rows — **preview first, delete inside a transaction.**

### B1. Preview exactly what will be deleted (re-run A3, eyeball it)

```sql
select id, occurred_at, description
from public.workout_logs
where description ~* '(did ?n''?t|do ?n''?t|couldn''?t|was ?n''?t|skip|missed|no gym|no workout|didn''t go|rest day|too tired|bailed)'
order by occurred_at desc;
```

Read every row. Make sure none is a *real* workout whose description merely
contains one of these words (e.g. "did NOT skip legs" — unlikely, but look).
If one is a false match, note its `id` and exclude it below.

### B2. Delete them (transaction — verify the count, then commit)

```sql
begin;

delete from public.workout_logs
where description ~* '(did ?n''?t|do ?n''?t|couldn''?t|was ?n''?t|skip|missed|no gym|no workout|didn''t go|rest day|too tired|bailed)'
  -- and id <> '<uuid-to-keep>'   -- uncomment to spare a false match from B1
;

-- Postgres prints the row count. If it matches what you saw in B1:
commit;
-- If anything looks off:
-- rollback;
```

> Prefer deleting explicit ids? Use
> `delete from public.workout_logs where id in ('<id1>','<id2>','<id3>');`

### B3. (Optional) also clear the audit trail for those rows

The `ai_actions` rows that created them will now point at deleted records.
Harmless, but to keep the history clean you can mark them:

```sql
update public.ai_actions
set status = 'reverted'
where tool_name = 'create_workout_log_candidate'
  and applied_record_table = 'workout_logs'
  and applied_record_id not in (select id from public.workout_logs);
```

### B4. Confirm

Reload the app → Gym / the day view for those dates → the workout is no longer
ticked. Re-run A3: it should return **0 rows**.

---

## Part C — Ship the gym fix (so it never happens again)

The code fix is committed on branch **`fix-gym-negation`** (see the session).
It makes the pipeline negation-aware: `stripNegatedClauses` removes "didn't go
to the gym" style clauses before any salvage, plus a hard override that drops a
workout/food candidate even if the model emits one. All 45 test files pass.

1. **Merge to `main`** (PR or local):
   ```bash
   git checkout main && git merge --no-ff fix-gym-negation && git push
   ```
   Pushing `main` triggers CI: **Pages** (frontend) + **`deploy-functions.yml`**
   redeploys the `agent` edge function.

2. **Verify the edge fn actually redeployed** (not a ghost version):
   ```powershell
   (Invoke-WebRequest "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/agent/body").Content -match 'stripNegatedClauses'
   ```
   Must print `True`. (If CI can't deploy from your proxied network, deploy via
   the Management API `PATCH /v1/projects/yyoewdcijplkhxleejtm/functions/agent`
   with JSON `{ verify_jwt:true, name:"agent", body:<source> }` — see
   `docs/jarvis-deploy.md` / the yyoe memory.)

3. **Live smoke test** — in the app, capture: **"didn't go to the gym today"**.
   Expected: **no** workout row, **no** tick, no green day. Then capture
   **"skipped gym but had dal and 2 rotis"** → a food log lands, gym stays
   empty.

4. *(Optional, your convention)* bump `src/version.js` `APP_VERSION` + `sw.js`
   `VERSION` so the build badge moves. This fix is edge-side, so client
   behaviour is unchanged — only needed if you want the badge to tick.

---

## Part D — Turn on the proactive machine (email/briefings/push)

The code shipped (commit `7b64469`, on `main`): `supabase/functions/nightly`,
the `_shared` detectors/composer, `push.js`, `supabase/nightly-cron.sql`. CI
deploys the *function*, but the machine stays **dark** until these one-time
manual steps run. Full detail: `docs/jarvis-deploy.md`. Condensed:

1. **Migration** — create `push_subscriptions`:
   run `supabase/migrations/20260705000015_push_subscriptions.sql` (Studio SQL
   editor, or `npm run db:push`).

2. **VAPID keys** (once): `node scripts/generate-vapid-keys.mjs` → run the
   printed `insert into public.app_secrets …` in the SQL editor.

3. **Cron secret** (once):
   ```sql
   insert into public.app_secrets (name, value)
   values ('NIGHTLY_SECRET', '<any long random string>')
   on conflict (name) do update set value = excluded.value;
   ```

4. **Deploy `nightly`** with `--no-verify-jwt` (CI does this on push to main;
   manual: `supabase functions deploy nightly --no-verify-jwt --project-ref yyoewdcijplkhxleejtm`).

5. **Push spike** — app → Settings → tick *Push notifications*, tap *Send test
   notification* (must get a real OS notification), then *Run my briefing now*.
   On iPhone: Add to Home Screen first, do it in the installed PWA.

6. **Register the cron** — run `supabase/nightly-cron.sql` (07:00 + 20:00 IST).

**Verify it's alive:**
```sql
select jobid, jobname, schedule from cron.job;                                    -- 2 jobs?
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, left(content,200) from net._http_response order by created desc limit 5;
select kind, for_date, left(body,200) from public.briefings order by created_at desc limit 5;
```

**Fire it now without waiting for 7 AM:**
```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/nightly" `
  -Headers @{ "x-nightly-secret" = "<NIGHTLY_SECRET>" } `
  -ContentType "application/json" -Body '{"slot":"evening"}'
```
Then re-run the A4 query — a fresh `briefings` row = the machine works.

---

## Part E — "Where are my emails?"

There is **no email ingestion** in the app today — nothing pulls bank-alert or
any other email into captures. The only "email" in the code is your login /
account field; commit `ce9bdd4` ("kill the email") only removed the email text
from the top bar (cosmetic). The "3 PM HDFC ₹101 email → one event" idea lives
in the rework vision as an aspiration, never built.

That's the third work item from the session (**Build email ingestion**) — it's
a new feature, scoped separately in `docs/email-ingestion-plan.md`.

---

## Appendix — table/column cheat sheet

| Table | Key columns |
|-------|-------------|
| `raw_ingestions` | `raw_text`, `source_type` (text/image/audio/file/mixed), `status`, `occurred_at`, `created_at` |
| `ai_runs` | `ingestion_id`, `provider`, `model`, `purpose`, `status`, `error_message`, `*_tokens` |
| `ai_actions` | `ingestion_id`, `ai_run_id`, `tool_name`, `arguments` (jsonb), `confidence`, `status`, `applied_record_table`, `applied_record_id`, `undo_payload` |
| `workout_logs` | `description`, `sets` (jsonb `[{exercise,muscle,reps,weight_kg,done}]`), `duration_min`, `occurred_at` |
| `briefings` | `kind` (morning/evening), `for_date`, `body`, `payload`, `seen` |
| `audit_log` | `action`, plus undo metadata (Jarvis feed uses this) |
