-- Adds RLS policies + storage buckets + signup trigger.
-- Idempotent: safe to re-run.

-- Profiles policy
drop policy if exists "Users manage own profile" on public.profiles;
create policy "Users manage own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Generic "users own their rows" policy on every user-owned table.
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

-- Storage buckets.
insert into storage.buckets (id, name, public)
values ('raw-media', 'raw-media', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('statements', 'statements', false)
on conflict (id) do nothing;

-- Per-user folder isolation on storage objects.
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

-- Auto-create a profile on signup.
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
