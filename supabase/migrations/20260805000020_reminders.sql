-- RECURRING REMINDERS - the calendar the app was missing.
--
-- Asked for in a note on 2026-08-04: "Set up automatic recurring reminders (like
-- Google Calendar) in the backend for recurring tasks. Specifically, by next
-- quarter the system should automatically remind me to file my quarterly GST
-- (deadline is the 10th of Jan/Apr/Jul/Oct)." Plus the shape stated out loud:
-- "birth date is 14 August" must fire EVERY year, not once.
--
-- Why this is not `notes.due_on`. A note carries ONE date and no rule, so the
-- day it passes the reminder is simply gone - which is exactly what happened to
-- the GST note (due_on 2026-10-09, and nothing would have fired again after it).
-- A recurrence needs a rule, not a date.
--
-- The rule is stored as its PARTS, not as an RRULE string, so the next
-- occurrence is computed by integer arithmetic in lib/reminders.mjs with no date
-- parsing and no timezone anywhere. A reminder is a calendar fact ("10 Jan"),
-- never an instant, which is why every column here is `date`/`int` and not
-- `timestamptz`. Every date bug this codebase has hit came from an instant read
-- in the wrong zone.

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,

  title text not null,
  note text,
  kind text not null default 'task'
    check (kind in ('task','birthday','anniversary','bill','filing','appointment','other')),

  -- the recurrence rule
  freq text not null
    check (freq in ('once','daily','weekly','monthly','quarterly','yearly')),
  day_of_month int check (day_of_month between 1 and 31),
  month_of_year int check (month_of_year between 1 and 12),  -- anchor for yearly/quarterly
  weekday int check (weekday between 0 and 6),               -- 0 = Sunday
  on_date date,                                              -- freq = 'once'

  -- how much warning this needs. A tax filing wants a week; a birthday wants a
  -- day. 0 means "only on the day".
  lead_days int not null default 0 check (lead_days between 0 and 60),

  active boolean not null default true,
  last_fired_on date,          -- so a slot cannot notify twice for one occurrence
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A rule must actually be computable. Without this a 'yearly' row with no
  -- month is storable and then silently never fires - the failure shape this
  -- codebase keeps rediscovering (a value is written, nothing reads it, no error).
  constraint reminders_rule_complete check (
    (freq = 'once'      and on_date is not null)
    or (freq = 'daily')
    or (freq = 'weekly'    and weekday is not null)
    or (freq = 'monthly'   and day_of_month is not null)
    or (freq in ('quarterly','yearly') and day_of_month is not null and month_of_year is not null)
  )
);

create index if not exists reminders_user_active_idx on public.reminders (user_id, active);

alter table public.reminders enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'reminders'
  ) then
    execute 'create policy "Users manage own rows" on public.reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id)';
  end if;
end$$;
