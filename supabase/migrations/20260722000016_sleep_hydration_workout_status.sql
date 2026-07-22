-- Sleep sessions, one-tap hydration, and an explicit workout status.
--
-- Three production defects this closes:
--
-- 1. workout_logs had no notion of "I did NOT train". The fan-out expander logged
--    a workout whenever a capture MENTIONED the gym, so "Did not go to gym bro"
--    became a completed workout, and jbCloseDay counts any row as workout_done -
--    which is why the next morning's brief said the user had trained. Rows now
--    carry status done|skipped|rest and only 'done' counts toward the streak.
--
-- 2. hydration_logs existed but had zero rows ever: no tool, no UI, no read path.
--
-- 3. There was no sleep source at all, yet the brief reported "sleep_h: 0" every
--    single day and voiced it as "you got zero sleep".
--
-- Idempotent.

-- 1. Workout status ---------------------------------------------------------
alter table public.workout_logs
  add column if not exists status text not null default 'done';

do $wl$
begin
  alter table public.workout_logs drop constraint if exists workout_logs_status_check;
  alter table public.workout_logs add constraint workout_logs_status_check
    check (status in ('done', 'skipped', 'rest'));
end$wl$;

create index if not exists ix_workout_user_status_occurred
  on public.workout_logs(user_id, status, occurred_at desc);

-- 2. Sleep sessions ---------------------------------------------------------
-- started_at only = "sleeping now"; ended_at fills in on wake. Duration is
-- derived, never stored, so a half-open session can never be read as 0 hours.
create table if not exists public.sleep_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  quality smallint check (quality is null or quality between 1 and 5),
  note text,
  source text not null default 'button',
  created_at timestamptz not null default now(),
  constraint sleep_sessions_order_check check (ended_at is null or ended_at > started_at)
);

create index if not exists ix_sleep_user_started on public.sleep_sessions(user_id, started_at desc);

-- At most one open (un-ended) session per user, so double-tapping "Sleeping"
-- cannot strand a second open row that never gets woken.
create unique index if not exists ux_sleep_one_open_per_user
  on public.sleep_sessions(user_id) where ended_at is null;

-- 3. Hydration --------------------------------------------------------------
create index if not exists ix_hydration_user_occurred
  on public.hydration_logs(user_id, occurred_at desc);

-- 4. RLS on the new table (and re-assert it on hydration, which had none of the
--    quick-add paths exercised before).
do $rls$
declare t text;
begin
  for t in select unnest(array['sleep_sessions', 'hydration_logs'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$rls$;

-- NOTE: this migration is schema-only and touches no existing rows. Repairing
-- the five phantom workout rows already in production is a separate, explicit
-- step - see scripts/repair-phantom-workouts.mjs (dry-run by default).
