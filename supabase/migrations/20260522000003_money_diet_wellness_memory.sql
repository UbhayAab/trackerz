-- Adds the per-user memory tables Wave 3-6 depends on.
-- Idempotent.

create table if not exists public.merchant_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  alias text not null,
  canonical text not null,
  created_at timestamptz not null default now(),
  unique(user_id, alias)
);

create table if not exists public.category_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_canonical text not null,
  category_id uuid not null references public.categories(id) on delete cascade,
  source text not null default 'user',
  created_at timestamptz not null default now(),
  unique(user_id, merchant_canonical)
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant text not null,
  cadence_days numeric(6,1) not null,
  median_amount numeric(14,2) not null,
  sample_count integer not null default 0,
  next_expected_at timestamptz,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(user_id, merchant)
);

create table if not exists public.bank_format_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  bank_key text not null,
  signature_hash text not null,
  column_map jsonb not null,
  sample_filename text,
  created_at timestamptz not null default now(),
  unique(user_id, signature_hash)
);

create table if not exists public.meal_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  meal_slot text check (meal_slot in ('breakfast','lunch','snack','dinner','other')),
  description text not null,
  calories_estimate integer,
  protein_g numeric(8,2),
  carbs_g numeric(8,2),
  fat_g numeric(8,2),
  use_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.hydration_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ml integer not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  summary jsonb not null,
  created_at timestamptz not null default now(),
  unique(user_id, week_start)
);

create table if not exists public.invited_emails (
  email text primary key,
  invited_by uuid references public.profiles(id) on delete set null,
  invited_at timestamptz not null default now(),
  used_at timestamptz
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  target_table text,
  target_id uuid,
  before jsonb,
  after jsonb,
  source text not null default 'user',
  created_at timestamptz not null default now()
);

create table if not exists public.user_secrets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  gemini_api_key_enc text,
  updated_at timestamptz not null default now()
);

-- RLS.
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'merchant_aliases','category_memory','subscriptions','bank_format_memory',
      'meal_templates','hydration_logs','weekly_reviews','audit_log','user_secrets'
    ])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$$;

-- Invited emails is global read by signed-in users, write only by service role.
alter table public.invited_emails enable row level security;
drop policy if exists "Anyone signed-in can read invites" on public.invited_emails;
create policy "Anyone signed-in can read invites" on public.invited_emails
  for select using (auth.uid() is not null);

-- Helpful indexes.
create index if not exists ix_subscriptions_next on public.subscriptions(user_id, next_expected_at);
create index if not exists ix_ledger_user_occurred on public.ledger_entries(user_id, occurred_at);
create index if not exists ix_food_user_occurred on public.food_logs(user_id, occurred_at);
create index if not exists ix_wellness_user_occurred on public.wellness_logs(user_id, occurred_at);
create index if not exists ix_audit_user_created on public.audit_log(user_id, created_at);
