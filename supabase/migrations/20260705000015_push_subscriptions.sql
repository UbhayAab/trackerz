-- Proactive Jarvis: Web Push. Each row is one device's push subscription
-- (endpoint + encryption keys from PushManager.subscribe). The client writes
-- its own rows (RLS), the nightly edge function reads them with service role
-- and prunes rows whose endpoint returns 404/410 (subscription expired).

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, endpoint)
);

do $$
begin
  execute 'alter table public.push_subscriptions enable row level security';
  execute 'drop policy if exists "Users manage own rows" on public.push_subscriptions';
  execute 'create policy "Users manage own rows" on public.push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id)';
end$$;

create index if not exists ix_push_subscriptions_user on public.push_subscriptions(user_id);
