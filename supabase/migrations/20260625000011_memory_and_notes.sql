-- Jarvis memory layer: durable facts + free-form notes/aspirations/todos.
-- memory_facts is long-term recall (upsert by key); notes are first-class captures
-- whose money/diet/gym implications cascade into budgets/targets (undoable via
-- audit_log). Mirrored into schema.sql (single source of truth).

create table if not exists public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  key text not null,
  value text not null,
  kind text not null default 'fact' check (kind in ('preference','pattern','fact','goal')),
  confidence numeric(5,4) not null default 0.7,
  source text not null default 'ai',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, key)
);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  kind text not null default 'note' check (kind in ('note','aspiration','todo','idea')),
  body text not null,
  domain text not null default 'general' check (domain in ('money','diet','gym','wellness','general')),
  status text not null default 'open' check (status in ('open','done','archived')),
  due_on date,
  event_group_id uuid,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- RLS: standard own-your-rows.
do $$
declare t text;
begin
  for t in select unnest(array['memory_facts','notes'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$$;

create index if not exists ix_memory_facts_user on public.memory_facts(user_id, kind, confidence desc, updated_at desc);
create index if not exists ix_notes_user_status on public.notes(user_id, status, created_at desc);
