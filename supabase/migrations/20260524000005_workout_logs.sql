-- Adds the workout_logs table the agent's create_workout_log_candidate tool
-- writes to. Without this table, high-confidence workout captures were silently
-- dropped (the tool was allow-listed but had nowhere to land). Idempotent.

create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  description text not null,
  duration_min numeric(6,1),
  intensity text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.workout_logs enable row level security;
drop policy if exists "Users manage own rows" on public.workout_logs;
create policy "Users manage own rows" on public.workout_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists ix_workout_user_occurred on public.workout_logs(user_id, occurred_at);
