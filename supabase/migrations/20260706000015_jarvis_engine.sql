-- Jarvis proactive engine — the "follow-on SQL" that 20260625000014_briefings.sql
-- promised. Turns the briefings table from a client-side stopgap into a scheduled
-- autonomous loop: pg_cron fires jarvis_ping() at three IST slots, which reads the
-- cron secret from app_secrets and asks pg_net to POST to the `jarvis` edge
-- function. The function closes out the day (habit_days, weekly_reviews), composes
-- the LLM-voiced brief (briefings), and delivers via Resend email + Web Push
-- (push_subscriptions). Everything here is idempotent.

-- 1. Scheduler + outbound HTTP from Postgres.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Briefings gains the close-out kinds (was morning|evening only).
alter table public.briefings drop constraint if exists briefings_kind_check;
alter table public.briefings add constraint briefings_kind_check
  check (kind in ('morning','evening','closeout','weekly'));

-- 3. Daily habit ledger: one row per user per local day, written by the nightly
--    close-out. flags feed streaks; streaks feed the morning brief + weekly review.
create table if not exists public.habit_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  flags jsonb not null default '{}'::jsonb,    -- { logged, workout, workout_forgiven, protein_hit, under_budget }
  streaks jsonb not null default '{}'::jsonb,  -- { workout, protein, budget, logging }
  summary jsonb not null default '{}'::jsonb,  -- closeDay() numbers (spend, protein, kcal, sleep, …)
  created_at timestamptz not null default now(),
  unique(user_id, day)
);
create index if not exists ix_habit_days_user_day on public.habit_days(user_id, day desc);

-- 4. Web Push subscriptions: one row per browser/device endpoint.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,                         -- { p256dh, auth } from PushSubscription.toJSON()
  ua text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists ix_push_subs_user on public.push_subscriptions(user_id);

do $jrls$
declare t text;
begin
  for t in select unnest(array['habit_days','push_subscriptions'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$jrls$;

-- 5. Delivery preferences. briefing_enabled (already present) stays the master
--    switch; these pick channels. Quiet hours are local (profiles.timezone).
alter table public.profiles add column if not exists push_enabled boolean not null default true;
alter table public.profiles add column if not exists email_brief boolean not null default true;
alter table public.profiles add column if not exists quiet_hours jsonb not null default '{"start":"22:30","end":"06:45"}'::jsonb;

-- 6. The cron→function bridge. SECURITY DEFINER so the cron job can read the
--    secret; EXECUTE is revoked from app roles below — only the postgres role
--    (which owns the cron jobs) and service_role may call it.
create or replace function public.jarvis_ping(action text)
returns bigint
language plpgsql
security definer
set search_path = public
as $jping$
declare
  secret text;
  req_id bigint;
begin
  select value into secret from public.app_secrets where name = 'JARVIS_CRON_SECRET';
  if secret is null then
    raise warning 'jarvis_ping: JARVIS_CRON_SECRET missing from app_secrets — skipping %', action;
    return null;
  end if;
  select net.http_post(
    url := 'https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/jarvis',
    body := jsonb_build_object('action', action),
    headers := jsonb_build_object('content-type', 'application/json', 'x-jarvis-secret', secret),
    timeout_milliseconds := 30000
  ) into req_id;
  return req_id;
end$jping$;

revoke all on function public.jarvis_ping(text) from public;
revoke all on function public.jarvis_ping(text) from anon, authenticated;

-- 7. Three IST slots (cron runs in UTC; IST = UTC+5:30):
--    close-out 00:05 IST = 18:35 UTC (previous UTC day), morning brief 07:00 IST
--    = 01:30 UTC, evening nudge 20:30 IST = 15:00 UTC.
do $jcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('jarvis_closeout','jarvis_morning','jarvis_evening')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$jcron$;

select cron.schedule('jarvis_closeout', '35 18 * * *', $$select public.jarvis_ping('closeout')$$);
select cron.schedule('jarvis_morning',  '30 1 * * *',  $$select public.jarvis_ping('morning')$$);
select cron.schedule('jarvis_evening',  '0 15 * * *',  $$select public.jarvis_ping('evening')$$);

-- 8. Live in-app arrival: publish briefings inserts over Supabase Realtime
--    (RLS still applies to subscribers).
do $jpub$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'briefings'
  ) then
    alter publication supabase_realtime add table public.briefings;
  end if;
exception when others then
  -- Realtime is a nice-to-have (live strip refresh); never block the migration.
  raise warning 'could not add briefings to supabase_realtime: %', sqlerrm;
end$jpub$;
