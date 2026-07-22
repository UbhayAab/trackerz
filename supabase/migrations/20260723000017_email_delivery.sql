-- Email notification service: per-kind preferences + a delivery log.
--
-- Email is the primary Jarvis channel (Web Push needs a per-device opt-in that
-- in practice never happens; push_subscriptions has 0 rows). Two gaps made the
-- old path untrustworthy:
--
-- 1. There was ONE switch (profiles.email_brief) for every kind of message, so
--    the only way to stop the evening nudge was to stop the morning brief too.
-- 2. sendEmail discarded Resend's response body, so the message id was never
--    stored and a bounce was invisible. "sent: true" only ever meant "the API
--    accepted it", which is not the same as "it arrived" — and there was no
--    record to check afterwards.
--
-- Idempotent.

-- 1. Per-kind delivery preferences. Defaults keep today's behaviour: the daily
--    brief and the nudge on, the nightly close-out off (it fires at 00:05 and
--    is the least useful thing to be emailed at midnight).
alter table public.profiles add column if not exists email_morning  boolean not null default true;
alter table public.profiles add column if not exists email_evening  boolean not null default true;
alter table public.profiles add column if not exists email_closeout boolean not null default false;
alter table public.profiles add column if not exists email_weekly   boolean not null default true;
alter table public.profiles add column if not exists email_alerts   boolean not null default true;

-- 2. Delivery log. One row per send ATTEMPT, so a failure is visible in the app
--    instead of living only in an edge-function log nobody reads.
create table if not exists public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  for_date date,
  to_email text not null,
  subject text not null,
  status text not null default 'queued',      -- queued | sent | failed
  provider_message_id text,                   -- Resend's id, for tracing a bounce
  error text,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint email_deliveries_status_check check (status in ('queued', 'sent', 'failed'))
);

create index if not exists ix_email_deliveries_user_created
  on public.email_deliveries(user_id, created_at desc);

-- One successful send per (user, kind, date). This is what makes a re-fired
-- cron slot or the GitHub Actions heartbeat safe: the second attempt collides
-- instead of sending the same brief twice.
create unique index if not exists ux_email_delivery_once
  on public.email_deliveries(user_id, kind, for_date)
  where status = 'sent' and for_date is not null;

alter table public.email_deliveries enable row level security;
drop policy if exists "Users manage own rows" on public.email_deliveries;
create policy "Users manage own rows" on public.email_deliveries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
