-- THE CALENDAR ENGINE - recurrence modifiers, fire-once claims, and the
-- minute-resolution autonomous scheduler.
--
-- Asked for out loud: "Calendar is where it will be putting down all its
-- scheduled tasks. And when the scheduled task, it has to trigger on its own and
-- wake up. That entire logic needs to be completely set."
--
-- Three problems, in the order they bite:
--
-- 1. The rules were too few. There was no interval ("every 2 weeks"), no
--    "3rd Tuesday", no until/count, no exdates, and no time of day at all - so
--    the finest thing the app could say was "sometime on the 14th", announced in
--    the 07:00 brief. Columns below carry the parts; lib/reminders.mjs does the
--    arithmetic (still integers on YYYY-MM-DD keys, still no Date object).
--
-- 2. Nothing recorded that a reminder had ALREADY fired. `reminders.last_fired_on`
--    was created, never read, never written - so a reminder inside its lead
--    window re-fired every single day: the GST filing at lead_days=7 is EIGHT
--    identical morning pushes. That is how a person learns to swipe away every
--    notification the app sends, which costs the other slots their credibility
--    too. A `date` column also cannot express two fires in one day, and an
--    update-after-send races the GitHub heartbeat. So the claim is an INSERT into
--    reminder_fires: a unique violation is a successful no-op, exactly the
--    pattern already proven on email_deliveries' partial unique index.
--
-- 3. Nothing woke up between the four fixed slots. agent_tasks + a per-minute
--    pg_cron tick fixes that, claimed with FOR UPDATE SKIP LOCKED and `<= now()`
--    so a missed minute still fires instead of being skipped forever.
--
-- Governance is not optional here: AUTO_APPLY_MIN_CONFIDENCE is 0, so anything
-- an autonomous run emits commits immediately with nobody watching at 03:00.
-- See profiles.autonomy_enabled (read server-side, FIRST, failing CLOSED), the
-- narrow tool allowlist in the jarvis function, the depth cap, the loop
-- detector, and the separate cost budget that cannot touch the human's.
--
-- Idempotent.

-- ===========================================================================
-- 1. Recurrence modifiers on `reminders`
-- ===========================================================================
-- Column names dodge two Postgres keywords on purpose: `interval` is a type name
-- and `count` is an aggregate, and both need quoting in enough places that one
-- unquoted use eventually ships broken. lib/reminders.mjs reads either spelling
-- (ruleInterval/ruleCount accept `interval`/`rule_interval` and `count`/
-- `max_count`), so the JSON rule form stays natural.

alter table public.reminders add column if not exists rule_interval int not null default 1;
alter table public.reminders add column if not exists dtstart date;
alter table public.reminders add column if not exists nth_weekday int;
alter table public.reminders add column if not exists weekdays int[];
alter table public.reminders add column if not exists until date;
alter table public.reminders add column if not exists max_count int;
alter table public.reminders add column if not exists exdates date[];
alter table public.reminders add column if not exists rdates date[];
alter table public.reminders add column if not exists at_time time;
alter table public.reminders add column if not exists timezone text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reminders_interval_check') then
    alter table public.reminders add constraint reminders_interval_check
      check (rule_interval between 1 and 366);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reminders_nth_weekday_check') then
    alter table public.reminders add constraint reminders_nth_weekday_check
      check (nth_weekday is null or (nth_weekday between -5 and 5 and nth_weekday <> 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reminders_max_count_check') then
    alter table public.reminders add constraint reminders_max_count_check
      check (max_count is null or max_count between 1 and 400);
  end if;
  -- An interval or a count with no anchor is unanswerable: "every 2 weeks"
  -- starting WHEN? Left unanchored the answer depends on the day you asked, and
  -- a fortnightly reminder drifts a week. The engine refuses such a rule; this
  -- stops one being stored in the first place.
  if not exists (select 1 from pg_constraint where conname = 'reminders_interval_needs_anchor') then
    alter table public.reminders add constraint reminders_interval_needs_anchor
      check ((rule_interval = 1 and max_count is null) or dtstart is not null or on_date is not null);
  end if;
end$$;

-- The completeness check now accepts an nth-weekday instead of a day of the
-- month, and a weekdays[] instead of the scalar weekday. Without this a
-- "3rd Tuesday" rule is unstorable and a Mon/Wed/Fri rule loses two of its days.
alter table public.reminders drop constraint if exists reminders_rule_complete;
alter table public.reminders add constraint reminders_rule_complete check (
  (freq = 'once'    and on_date is not null)
  or (freq = 'daily')
  or (freq = 'weekly'  and (weekday is not null or coalesce(array_length(weekdays, 1), 0) > 0))
  or (freq = 'monthly' and (day_of_month is not null
        or (nth_weekday is not null and (weekday is not null or coalesce(array_length(weekdays, 1), 0) > 0))))
  or (freq in ('quarterly', 'yearly')
        and (day_of_month is not null
          or (nth_weekday is not null and (weekday is not null or coalesce(array_length(weekdays, 1), 0) > 0)))
        and (month_of_year is not null or dtstart is not null))
);

comment on column public.reminders.last_fired_on is
  'DEPRECATED (20260806000030). Never read or written by any code, and a date cannot express two fires in one day. reminder_fires is the claim of record.';
comment on column public.reminders.at_time is
  'Local time of day in `timezone` (or the profile zone). NULL = date granularity, announced in the 07:00 brief; a value = claimed and pushed by the per-minute task tick.';

-- ===========================================================================
-- 2. reminder_fires - the claim that makes a fire happen exactly once
-- ===========================================================================
-- The INSERT *is* the claim. Two schedulers racing the same occurrence both try
-- to insert; one wins, the loser gets a unique violation and treats it as a
-- successful no-op. Nothing is updated after the send, so nothing can race.
create table if not exists public.reminder_fires (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  -- occurrenceKey() from lib/reminders.mjs: "2026-08-14" or "2026-08-14T18:30".
  -- Computed inside the MIRROR block so the edge function and any on-device
  -- scheduler derive the same string from the same code.
  occurrence_key text not null,
  channel text not null default 'push',
  fired_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  constraint reminder_fires_once unique (reminder_id, occurrence_key, channel)
);
create index if not exists ix_reminder_fires_user on public.reminder_fires(user_id, fired_at desc);

-- ===========================================================================
-- 3. job_runs - the generalised slot claim, with a stale lease
-- ===========================================================================
-- pg_cron is the primary clock and .github/workflows/jarvis-heartbeat.yml re-fires
-- the same actions minutes later. They are meant to COLLIDE, not double-fire.
-- The lease exists because a claim taken by a run that then crashed must not
-- wedge the slot forever - after `lease_seconds` the next caller may take it.
create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job text not null,
  slot_key text not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  attempts int not null default 1,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  detail jsonb not null default '{}'::jsonb,
  constraint job_runs_slot_once unique (user_id, job, slot_key)
);
create index if not exists ix_job_runs_claimed on public.job_runs(job, claimed_at desc);

create or replace function public.claim_job(
  p_user uuid, p_job text, p_slot text, p_lease_seconds int default 600
) returns boolean
language plpgsql
security definer
set search_path = public
as $claim$
declare got boolean;
begin
  insert into public.job_runs (user_id, job, slot_key, status, claimed_at)
  values (p_user, p_job, p_slot, 'running', now())
  on conflict (user_id, job, slot_key) do update
     set claimed_at = now(),
         status = 'running',
         attempts = public.job_runs.attempts + 1
   where public.job_runs.status <> 'done'
     and public.job_runs.claimed_at < now() - make_interval(secs => p_lease_seconds)
  returning true into got;
  return coalesce(got, false);
end$claim$;

create or replace function public.finish_job(p_user uuid, p_job text, p_slot text, p_status text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $finish$
  update public.job_runs
     set status = case when p_status in ('done', 'failed') then p_status else 'done' end,
         finished_at = now(),
         detail = coalesce(p_detail, '{}'::jsonb)
   where user_id = p_user and job = p_job and slot_key = p_slot;
$finish$;

revoke all on function public.claim_job(uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.finish_job(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ===========================================================================
-- 4. agent_tasks - what the agent scheduled for itself
-- ===========================================================================
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  fire_at timestamptz not null,
  tz text not null default 'Asia/Kolkata',
  -- A lib/reminders.mjs rule as JSON, or NULL for a one-shot. Stored as the rule
  -- PARTS for the same reason `reminders` is: the next fire is integer
  -- arithmetic on date keys, never a parsed instant.
  recurrence jsonb,

  intent text not null default 'check'
    check (intent in ('check', 'answer', 'remind', 'review')),
  prompt text not null,

  created_by text not null default 'user' check (created_by in ('user', 'agent', 'system')),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'running', 'done', 'failed', 'disabled')),

  origin_ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  dedupe_key text,
  -- A task may not create a task. Depth 0 is a human-scheduled task; 1 is one an
  -- agent run scheduled; the runner refuses to schedule anything at depth >= 1,
  -- so a self-rescheduling loop cannot exist.
  depth int not null default 0 check (depth between 0 and 3),

  claimed_at timestamptz,
  last_run_at timestamptz,
  runs int not null default 0,
  -- Three consecutive failures trips a VISIBLE breaker (status='disabled' plus a
  -- reason) rather than retrying silently every minute forever.
  consecutive_failures int not null default 0,
  disabled_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_agent_tasks_dedupe
  on public.agent_tasks(user_id, dedupe_key) where dedupe_key is not null;
create index if not exists ix_agent_tasks_due
  on public.agent_tasks(fire_at) where status = 'scheduled';
create index if not exists ix_agent_tasks_user on public.agent_tasks(user_id, fire_at desc);

-- One row per attempted run, CLAIMED BEFORE THE MODEL CALL so a crash is
-- distinguishable from "never ran". A run that produces zero actions still
-- writes its row - silence has to be a logged outcome, not an absence.
create table if not exists public.agent_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- occurrenceKey() of this firing. The unique index below IS the claim.
  slot_key text not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'silent', 'spoke', 'failed', 'blocked')),
  result text,
  -- Hash of the actions this run emitted. The same (task, hash) three times in
  -- 24h means the task is looping and gets disabled.
  action_hash text,
  actions int not null default 0,
  -- Autonomous spend is accounted HERE and never in ai_runs, so a self-scheduled
  -- run can consume neither the human's 60-per-5-min rate limit nor their $2/day
  -- cap. A background agent locking the user out of their own app is not a
  -- theoretical failure.
  cost_usd numeric(12, 6) not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint agent_task_runs_once unique (task_id, slot_key)
);
create index if not exists ix_agent_task_runs_user on public.agent_task_runs(user_id, started_at desc);
create index if not exists ix_agent_task_runs_hash on public.agent_task_runs(task_id, action_hash, started_at desc);

-- Claim due tasks. `fire_at <= now()`, NEVER `= now()`: a minute the scheduler
-- missed (a cold start, a deploy, a pg_net timeout) must still fire late rather
-- than be skipped for good. SKIP LOCKED so the pg_cron tick and the GitHub
-- heartbeat arriving together take DIFFERENT rows instead of both taking one.
create or replace function public.claim_agent_tasks(p_user uuid, p_limit int default 5)
returns setof public.agent_tasks
language plpgsql
security definer
set search_path = public
as $claimtasks$
begin
  -- Recover anything a crashed run left marked running. Without this one crash
  -- wedges a task permanently, which reads exactly like "the agent stopped".
  update public.agent_tasks
     set status = 'scheduled', updated_at = now()
   where user_id = p_user and status = 'running'
     and claimed_at is not null and claimed_at < now() - interval '10 minutes';

  return query
  with picked as (
    select id from public.agent_tasks
     where user_id = p_user and status = 'scheduled' and fire_at <= now()
     order by fire_at
     for update skip locked
     limit greatest(1, least(p_limit, 20))
  )
  update public.agent_tasks t
     set status = 'running', claimed_at = now(), updated_at = now()
    from picked
   where t.id = picked.id
  returning t.*;
end$claimtasks$;

revoke all on function public.claim_agent_tasks(uuid, int) from public, anon, authenticated;

-- ===========================================================================
-- 5. Autonomy governance flags on `profiles`
-- ===========================================================================
-- Read SERVER-SIDE, FIRST, and failing CLOSED. A client flag cannot stop a
-- server-side agent, and an unreadable flag must never read as permission - this
-- is the one read in the codebase that must fail closed rather than surface an
-- error, because the alternative is an unsupervised model writing to the DB.
alter table public.profiles add column if not exists autonomy_enabled boolean not null default false;
-- A separate, lower budget. The human's cap is DAILY_COST_CAP_USD = 2 over
-- ai_runs; this one is over agent_task_runs.cost_usd and cannot touch it.
alter table public.profiles add column if not exists autonomy_daily_cost_usd numeric(8, 4) not null default 0.25;

-- Existing users who already have the proactive engine on get autonomy on, so
-- the feature they asked for actually runs. New profiles default to OFF: an
-- account that never opted into anything must not acquire a background agent.
update public.profiles set autonomy_enabled = true
 where briefing_enabled = true and autonomy_enabled = false;

-- ===========================================================================
-- 6. RLS
-- ===========================================================================
do $rls$
declare t text;
begin
  for t in select unnest(array['reminder_fires', 'job_runs', 'agent_tasks', 'agent_task_runs'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$rls$;

-- ===========================================================================
-- 7. The minute clock
-- ===========================================================================
-- Every minute, not every 5: a reminder set for 18:30 that fires at 18:34 is a
-- different product. The tick is cheap and SILENT by design - with nothing due
-- it is one indexed query per profile and returns without writing anything.
do $jcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'jarvis_tasks'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$jcron$;

select cron.schedule('jarvis_tasks', '* * * * *', $$select public.jarvis_ping('task')$$);
