-- Proactive Jarvis: scheduled morning/evening briefings. The briefing edge fn
-- (run by pg_cron via pg_net) writes one row per user per slot; the Home insight
-- strip renders the latest. profiles.briefing_enabled gates the schedule.
-- The pg_cron registration lives in a follow-on SQL once the function URL/secret
-- are known (it needs the deployed function endpoint), kept out of this migration.

alter table public.profiles add column if not exists briefing_enabled boolean not null default true;

create table if not exists public.briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('morning','evening')),
  for_date date not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  unique(user_id, kind, for_date)
);

do $$
begin
  execute 'alter table public.briefings enable row level security';
  execute 'drop policy if exists "Users manage own rows" on public.briefings';
  execute 'create policy "Users manage own rows" on public.briefings for all using (auth.uid() = user_id) with check (auth.uid() = user_id)';
end$$;

create index if not exists ix_briefings_user_date on public.briefings(user_id, for_date desc, kind);
