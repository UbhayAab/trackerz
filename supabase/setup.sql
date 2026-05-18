-- Trackerz one-shot setup.
-- Safe to re-run. Paste this into Supabase SQL Editor (or use psql) once.
-- It applies RLS policies, storage buckets, auto-profile trigger, and
-- the discretionary/Nifty additions needed by the live UI.

-- 1. RLS policies on user-owned tables.
drop policy if exists "Users manage own profile" on public.profiles;
create policy "Users manage own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

do $$
declare t text;
begin
  for t in
    select unnest(array[
      'raw_ingestions','media_assets','ai_runs','ai_actions','categories',
      'ledger_entries','statement_imports','statement_rows','budgets',
      'food_logs','body_metrics','wellness_logs','duplicate_candidates'
    ])
  loop
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$$;

-- 2. Storage buckets, per-user folder isolation.
insert into storage.buckets (id, name, public)
values ('raw-media', 'raw-media', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('statements', 'statements', false)
on conflict (id) do nothing;

drop policy if exists "Users read own media" on storage.objects;
create policy "Users read own media" on storage.objects
  for select using (
    bucket_id in ('raw-media','statements')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users write own media" on storage.objects;
create policy "Users write own media" on storage.objects
  for insert with check (
    bucket_id in ('raw-media','statements')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users update own media" on storage.objects;
create policy "Users update own media" on storage.objects
  for update using (
    bucket_id in ('raw-media','statements')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users delete own media" on storage.objects;
create policy "Users delete own media" on storage.objects
  for delete using (
    bucket_id in ('raw-media','statements')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- 3. Auto-create a profile row when an auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Discretionary/tag columns + Nifty reference table.
alter table public.ledger_entries
  add column if not exists is_discretionary boolean not null default false;

alter table public.ledger_entries
  add column if not exists tags text[] not null default '{}';

create table if not exists public.nifty_monthly_closes (
  month date primary key,
  close numeric(14,2) not null
);

alter table public.nifty_monthly_closes enable row level security;
drop policy if exists "Anyone can read nifty closes" on public.nifty_monthly_closes;
create policy "Anyone can read nifty closes" on public.nifty_monthly_closes
  for select using (true);
