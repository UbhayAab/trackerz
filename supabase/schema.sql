-- Ubhay Life OS schema draft.
-- Apply only after reviewing RLS and secrets. Every user-owned table must enable RLS.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Ubhay',
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.raw_ingestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null check (source_type in ('text','image','audio','file','mixed')),
  capture_mode text not null default 'auto',
  raw_text text,
  occurred_at timestamptz,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete cascade,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text not null,
  original_name text,
  byte_size bigint,
  media_kind text not null check (media_kind in ('image','audio','statement','document','other')),
  created_at timestamptz not null default now()
);

create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  provider text not null,
  model text not null,
  purpose text not null,
  prompt_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12,6),
  latency_ms integer,
  status text not null default 'started',
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ai_run_id uuid references public.ai_runs(id) on delete set null,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  tool_name text not null,
  arguments jsonb not null,
  confidence numeric(5,4) not null default 0,
  status text not null default 'proposed',
  applied_record_table text,
  applied_record_id uuid,
  undo_payload jsonb,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null check (domain in ('money','diet','fitness','wellness')),
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique(user_id, domain, name)
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  amount numeric(14,2) not null,
  currency text not null default 'INR',
  direction text not null check (direction in ('expense','income','transfer')),
  merchant text,
  description text,
  payment_mode text,
  occurred_at timestamptz not null,
  confidence numeric(5,4) not null default 1,
  duplicate_state text not null default 'unique',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.statement_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  source_name text,
  detected_bank text,
  mapping jsonb,
  status text not null default 'uploaded',
  row_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.statement_rows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  import_id uuid not null references public.statement_imports(id) on delete cascade,
  row_hash text not null,
  occurred_on date,
  description text,
  debit numeric(14,2),
  credit numeric(14,2),
  balance numeric(14,2),
  reference text,
  ledger_entry_id uuid references public.ledger_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(user_id, import_id, row_hash)
);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category_id uuid references public.categories(id) on delete cascade,
  period text not null check (period in ('daily','weekly','monthly')),
  amount numeric(14,2) not null,
  starts_on date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.food_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  meal_name text,
  meal_slot text check (meal_slot in ('breakfast','lunch','snack','dinner','other')),
  description text not null,
  calories_estimate integer,
  protein_g numeric(8,2),
  carbs_g numeric(8,2),
  fat_g numeric(8,2),
  confidence numeric(5,4) not null default 0,
  duplicate_state text not null default 'unique',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  metric_type text not null check (metric_type in ('weight','sleep_hours','steps','water_ml')),
  value numeric(12,3) not null,
  unit text not null,
  occurred_at timestamptz not null,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.wellness_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  note text not null,
  mood_score integer check (mood_score between 1 and 10),
  energy_score integer check (energy_score between 1 and 10),
  stress_score integer check (stress_score between 1 and 10),
  occurred_at timestamptz not null,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null check (domain in ('money','diet','fitness','wellness')),
  record_a_table text not null,
  record_a_id uuid not null,
  record_b_table text not null,
  record_b_id uuid not null,
  score numeric(5,4) not null,
  reason text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.raw_ingestions enable row level security;
alter table public.media_assets enable row level security;
alter table public.ai_runs enable row level security;
alter table public.ai_actions enable row level security;
alter table public.categories enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.statement_imports enable row level security;
alter table public.statement_rows enable row level security;
alter table public.budgets enable row level security;
alter table public.food_logs enable row level security;
alter table public.body_metrics enable row level security;
alter table public.wellness_logs enable row level security;
alter table public.duplicate_candidates enable row level security;

-- Profiles: id IS the user id, not user_id.
drop policy if exists "Users manage own profile" on public.profiles;
create policy "Users manage own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- All other user-owned tables share the same pattern.
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

-- Storage buckets. Private; access mediated by RLS policies on storage.objects.
insert into storage.buckets (id, name, public)
values ('raw-media', 'raw-media', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('statements', 'statements', false)
on conflict (id) do nothing;

-- Each user can only read/write objects under a folder named with their auth.uid().
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

-- Auto-create a profile row on signup.
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
