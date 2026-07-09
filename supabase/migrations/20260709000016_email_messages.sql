-- Email ingestion idempotency. One row per delivered email so the same message is
-- never ingested twice — keyed by RFC Message-ID, or a synthetic
-- sender|subject|day key when the delivery layer has no Message-ID. The
-- email-inbound edge function reserves the key BEFORE creating the capture; a
-- unique-violation means "already seen, skip". Re-running this migration is safe.
create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  dedupe_key text not null,
  sender text,
  subject text,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create index if not exists ix_email_messages_user on public.email_messages(user_id);

alter table public.email_messages enable row level security;
drop policy if exists "Users manage own rows" on public.email_messages;
create policy "Users manage own rows" on public.email_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
