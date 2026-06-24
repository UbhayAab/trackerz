-- User-editable diet/gym plan (DB-backed so the AI can rewrite it on request).
-- scope='permanent' = standing plan; a 'YYYY-MM-DD' scope = one-day temporary
-- override. payload holds the parsed plan. Idempotent; mirrored in schema.sql.

create table if not exists public.user_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'diet' check (kind in ('diet','gym')),
  scope text not null default 'permanent',
  summary text,
  payload jsonb not null default '{}'::jsonb,
  source text not null default 'ai',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists ix_user_plans_lookup on public.user_plans(user_id, kind, scope, active, created_at desc);

alter table public.user_plans enable row level security;
drop policy if exists "Users manage own rows" on public.user_plans;
create policy "Users manage own rows" on public.user_plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
