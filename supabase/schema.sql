-- Ubhay Life OS schema draft.
-- Apply only after reviewing RLS and secrets. Every user-owned table must enable RLS.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Ubhay',
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  briefing_enabled boolean not null default true,
  -- Jarvis delivery preferences (20260706000015_jarvis_engine.sql).
  push_enabled boolean not null default true,
  email_brief boolean not null default true,
  quiet_hours jsonb not null default '{"start":"22:30","end":"06:45"}'::jsonb,
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
  -- Clock-free hash of (user, normalised text, media ids). The edge function
  -- checks it before running anything, so a retried invoke replays the earlier
  -- run instead of writing the ledger a second time. Deliberately NOT unique:
  -- buying the same lunch twice in a week is legitimate.
  capture_fingerprint text,
  duplicate_of_ingestion_id uuid references public.raw_ingestions(id) on delete set null,
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

-- The user's own accounts, learned from imported statements rather than typed
-- in. This is what lets a payment to KKBK0008109 be recognised as the user's own
-- money the moment that Kotak statement has been seen once - without it, money
-- moved between two of your own banks is indistinguishable from money spent.
create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  bank text,
  account_number text,
  account_last4 text,
  ifsc text,
  micr text,
  customer_id text,
  account_holder text,
  nickname text,
  kind text not null default 'bank' check (kind in ('bank','credit_card','wallet','loan','investment')),
  currency text not null default 'INR',
  -- A balance without the date it was true on is a number that quietly rots.
  last_balance numeric(14,2),
  last_balance_on date,
  vpas text[] not null default '{}',
  is_own boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_bank_accounts_user_number
  on public.bank_accounts(user_id, account_number) where account_number is not null;
create index if not exists ix_bank_accounts_user on public.bank_accounts(user_id);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  account_id uuid references public.bank_accounts(id) on delete set null,
  amount numeric(14,2) not null,
  currency text not null default 'INR',
  direction text not null check (direction in ('expense','income','transfer')),
  merchant text,
  description text,
  payment_mode text,
  occurred_at timestamptz not null,
  confidence numeric(5,4) not null default 1,
  duplicate_state text not null default 'unique',
  is_discretionary boolean not null default false,
  tags text[] not null default '{}',
  -- Smart-matching inputs + state (see 20260625000012_dedupe_merge.sql).
  source_type text,                                                      -- bank|file|image|audio|text|mixed (survivorship rank)
  reference text,                                                        -- UPI ref / UTR / external ref (hard-dup signal)
  account text,                                                          -- transfer detection (different account)
  event_group_id uuid,                                                   -- transitive "one real event" cluster id
  merged_into uuid references public.ledger_entries(id) on delete set null,
  -- What KIND of movement this is. `direction` (expense/income/transfer) cannot
  -- tell a credit-card bill from a grocery run, or a mutual-fund purchase from
  -- rent - and a bank statement is mostly made of that distinction.
  flow_type text check (flow_type is null or flow_type in (
    'spend','income','p2p_out','p2p_in',
    'self_transfer_out','self_transfer_in',
    'investment','investment_return',
    'card_payment','loan_emi','loan_principal','loan_disbursal',
    'refund','bank_charge','interest','wallet_load','cash',
    'unknown_out','unknown_in'
  )),
  counterparty text,
  counterparty_vpa text,
  rail text,                                                             -- upi|neft|imps|nach|billpay|loan|atm|...
  balance_after numeric(14,2),
  -- False for transfers, investments and card bill payments: money that moved
  -- without being spent. Every spending total must filter on this.
  counts_as_spending boolean not null default true,
  counts_as_income boolean not null default false,
  classification_confidence numeric(5,4),
  classification_reasons text[] not null default '{}',
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_ledger_flow on public.ledger_entries(user_id, flow_type);
create index if not exists ix_ledger_account on public.ledger_entries(user_id, account_id, occurred_at);
create index if not exists ix_ledger_spending on public.ledger_entries(user_id, occurred_at)
  where counts_as_spending;

-- Pairs of entries that are one real event, or one cancelling another. Its own
-- table rather than a column because a refund of a triple-charge points at
-- THREE debits, and the reason for each link has to survive so a wrong one can
-- be found and undone.
create table if not exists public.ledger_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('self_transfer','refund','duplicate_charge','manual_match')),
  from_entry_id uuid references public.ledger_entries(id) on delete cascade,
  to_entry_id uuid references public.ledger_entries(id) on delete cascade,
  amount numeric(14,2),
  confidence numeric(5,4) not null default 1,
  reason text,
  state text not null default 'applied' check (state in ('suggested','applied','rejected')),
  created_at timestamptz not null default now()
);
create unique index if not exists ux_ledger_links_pair
  on public.ledger_links(user_id, kind, from_entry_id, to_entry_id);
create index if not exists ix_ledger_links_user on public.ledger_links(user_id, kind, state);

-- Recurring payments detected from history, so a MISSING instance can be
-- noticed. A subscription that kept charging shows up in any category total; an
-- EMI that stopped only shows up if something was expecting it.
create table if not exists public.recurring_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  series_key text not null,
  counterparty text,
  direction text not null check (direction in ('out','in')),
  cadence text not null check (cadence in ('weekly','monthly','quarterly','yearly')),
  amount numeric(14,2),
  amount_varies boolean not null default false,
  occurrences integer not null default 0,
  first_seen date,
  last_seen date,
  expected_next date,
  missed boolean not null default false,
  annualised numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_recurring_series_user_key
  on public.recurring_series(user_id, series_key);

create table if not exists public.statement_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  account_id uuid references public.bank_accounts(id) on delete set null,
  source_name text,
  detected_bank text,
  mapping jsonb,
  status text not null default 'uploaded',
  row_count integer not null default 0,
  period_from date,
  period_to date,
  -- The verification verdict from lib/statement-audit.mjs: proven | consistent
  -- | suspect. Stored so a statement whose arithmetic never reconciled is not
  -- silently trusted by anything reading the ledger later.
  audit_confidence text,
  audit_summary text,
  audit_failures text[] not null default '{}',
  declared_totals jsonb,
  computed_totals jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.statement_rows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  import_id uuid not null references public.statement_imports(id) on delete cascade,
  account_id uuid references public.bank_accounts(id) on delete set null,
  row_hash text not null,
  occurred_on date,
  txn_time text,
  flow_type text,
  counterparty text,
  description text,
  debit numeric(14,2),
  credit numeric(14,2),
  balance numeric(14,2),
  reference text,
  ledger_entry_id uuid references public.ledger_entries(id) on delete set null,
  -- Content-only dedupe key (no import_id). Keying on the import id guaranteed a
  -- miss: a re-import mints a new id, so every row looked new. See the unique
  -- index below, which replaces the old unique(user_id, import_id, row_hash).
  content_key text,
  promoted_at timestamptz,
  promotion_error text,
  created_at timestamptz not null default now()
);
create unique index if not exists ux_statement_rows_user_content
  on public.statement_rows(user_id, content_key);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category_id uuid references public.categories(id) on delete cascade,
  period text not null check (period in ('daily','weekly','monthly')),
  amount numeric(14,2) not null,
  starts_on date not null,
  -- Stable budget/goal key (monthly_spend, daily_protein, …). ONE row per
  -- (user, kind) so editing a budget anywhere upserts the single canonical row
  -- and propagates everywhere. The single source of truth for budgets + targets.
  kind text,
  created_at timestamptz not null default now()
);
create unique index if not exists budgets_user_kind_uniq on public.budgets (user_id, kind);

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
  event_group_id uuid,                                                   -- links a meal to its spend (cross-domain, never merged)
  occurred_at timestamptz not null,
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  metric_type text not null check (metric_type in ('weight','sleep_hours','steps','water_ml','body_fat_pct','waist_cm')),
  value numeric(12,3) not null,
  unit text not null,
  occurred_at timestamptz not null,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
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
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
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

-- ============================================================================
-- Tables folded in from migrations. schema.sql is the single source of truth;
-- migrations remain for incremental deploys and are idempotent (if not exists).
-- tests/schema-contract.test.mjs fails the build if a migration table is not
-- mirrored here.
-- ============================================================================

create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  description text not null,
  duration_min numeric(6,1),
  intensity text,
  -- Per-exercise sets for the detailed gym tracker. One workout_logs row = one
  -- session; `sets` is [{exercise, muscle, set, reps, weight_kg, done}]. Kept on
  -- the existing table (no extra tables) per the owner's "don't make 100 tables".
  sets jsonb not null default '[]'::jsonb,
  bodyweight_kg numeric,
  notes text,
  -- done | skipped | rest. A 'skipped' row records that the user ANSWERED the
  -- day ("no gym today") without it counting as training. Counting every row as
  -- a workout is what made the brief report gym sessions the user had denied.
  status text not null default 'done' check (status in ('done','skipped','rest')),
  occurred_at timestamptz not null,
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Sleep. started_at alone = "asleep right now"; ended_at fills in on wake, and
-- duration is always derived, so a half-open session can never read as 0 hours.
create table if not exists public.sleep_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  quality smallint check (quality is null or quality between 1 and 5),
  note text,
  source text not null default 'button',
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sleep_sessions_order_check check (ended_at is null or ended_at > started_at)
);

create table if not exists public.nifty_monthly_closes (
  month date primary key,
  close numeric(14,2) not null
);

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
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
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

-- User-editable diet/gym plan. scope='permanent' is the standing plan; a
-- 'YYYY-MM-DD' scope is a one-day temporary override. payload holds the parsed
-- plan (meals/workouts + macros). Latest active row per (user,kind,scope) wins.
create table if not exists public.user_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'diet' check (kind in ('diet','gym')),
  scope text not null default 'permanent',
  summary text,
  payload jsonb not null default '{}'::jsonb,
  source text not null default 'ai',
  active boolean not null default true,
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ix_user_plans_lookup on public.user_plans(user_id, kind, scope, active, created_at desc);

-- Jarvis memory (20260625000011_memory_and_notes.sql). memory_facts = durable
-- long-term recall (upsert by key); notes = first-class captures whose
-- money/diet/gym implications cascade into budgets/targets (undoable via audit_log).
create table if not exists public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  key text not null,
  value text not null,
  kind text not null default 'fact' check (kind in ('preference','pattern','fact','goal')),
  confidence numeric(5,4) not null default 0.7,
  source text not null default 'ai',
  -- WHICH EVIDENCE SPAN justified this fact (20260806000060). These rows are
  -- replayed into every later prompt, so a fact the model derived from a
  -- photographed menu must never read back as something the owner said.
  -- typed/voice = the owner; ocr/vision/sms/calendar = untrusted; null = written
  -- before the column existed. See lib/provenance.mjs.
  provenance text check (provenance is null or provenance in
    ('typed', 'voice', 'ocr', 'vision', 'sms', 'calendar', 'memory', 'unknown')),
  updated_at timestamptz not null default now(),
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
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
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Recurring reminders (20260805000020). The calendar the app was missing: a
-- birthday that fires every year, a quarterly filing that speaks up a week early.
-- Stored as rule PARTS, not an RRULE string, so lib/reminders.mjs computes the
-- next occurrence with integer arithmetic and never parses a date or touches a
-- timezone. Every column is date/int, never timestamptz - a reminder is a
-- calendar fact ("10 Jan"), not an instant.
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  title text not null,
  note text,
  kind text not null default 'task'
    check (kind in ('task','birthday','anniversary','bill','filing','appointment','other')),
  freq text not null
    check (freq in ('once','daily','weekly','monthly','quarterly','yearly')),
  day_of_month int check (day_of_month between 1 and 31),
  month_of_year int check (month_of_year between 1 and 12),
  weekday int check (weekday between 0 and 6),
  on_date date,
  lead_days int not null default 0 check (lead_days between 0 and 60),
  active boolean not null default true,
  last_fired_on date,
  -- Soft delete (20260806000022). A tombstone, not a removal: every read
  -- filters `deleted_at is null`; only the 30-day purge hard-deletes.
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A rule must be computable. Without this a 'yearly' row with no month is
  -- storable and then silently never fires.
  constraint reminders_rule_complete check (
    (freq = 'once'      and on_date is not null)
    or (freq = 'daily')
    or (freq = 'weekly'    and weekday is not null)
    or (freq = 'monthly'   and day_of_month is not null)
    or (freq in ('quarterly','yearly') and day_of_month is not null and month_of_year is not null)
  )
);
create index if not exists reminders_user_active_idx on public.reminders (user_id, active);

-- Proactive Jarvis briefings (20260625000014 + 20260706000015). One row per user
-- per slot, written by the scheduled `jarvis` edge fn; Home renders the latest.
create table if not exists public.briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- 'midday' was added by the fourth slot but never permitted here until
  -- 20260806000021, so runMidday could not have written a row even once the
  -- action allowlist let it through. See that migration for the full story.
  kind text not null check (kind in ('morning','midday','evening','closeout','weekly')),
  for_date date not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  unique(user_id, kind, for_date)
);

-- Jarvis daily habit ledger (20260706000015_jarvis_engine.sql): one row per user
-- per local day, written by the nightly close-out; feeds streaks + weekly review.
create table if not exists public.habit_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  flags jsonb not null default '{}'::jsonb,
  streaks jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, day)
);

-- Web Push subscriptions (20260706000015): one row per browser/device endpoint.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  ua text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

-- One row per email send ATTEMPT. Without it "sent: true" only ever meant
-- "Resend accepted the request", the message id was discarded, and a bounce was
-- invisible. The partial unique index below is also what makes a re-fired cron
-- slot safe: the second attempt collides instead of sending the brief twice.
create table if not exists public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  for_date date,
  to_email text not null,
  subject text not null,
  status text not null default 'queued',
  provider_message_id text,
  error text,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint email_deliveries_status_check check (status in ('queued', 'sent', 'failed'))
);
create unique index if not exists ux_email_delivery_once
  on public.email_deliveries(user_id, kind, for_date)
  where status = 'sent' and for_date is not null;

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

create table if not exists public.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.raw_ingestions enable row level security;
alter table public.media_assets enable row level security;
alter table public.ai_runs enable row level security;
alter table public.ai_actions enable row level security;
alter table public.categories enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.ledger_links enable row level security;
alter table public.recurring_series enable row level security;
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
      'ledger_entries','bank_accounts','ledger_links','recurring_series',
      'statement_imports','statement_rows','budgets',
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

-- ============================================================================
-- RLS + policies + indexes for the folded-in tables.
-- ============================================================================

-- User-owned tables share the standard "own your rows" policy.
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'workout_logs','merchant_aliases','category_memory','subscriptions',
      'bank_format_memory','meal_templates','hydration_logs','weekly_reviews',
      'audit_log','user_secrets','user_plans','memory_facts','notes','briefings',
      'habit_days','push_subscriptions','sleep_sessions','email_deliveries',
      'reminders'
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

-- Nifty closes: global reference data, readable by anyone.
alter table public.nifty_monthly_closes enable row level security;
drop policy if exists "Anyone can read nifty closes" on public.nifty_monthly_closes;
create policy "Anyone can read nifty closes" on public.nifty_monthly_closes
  for select using (true);

-- Invited emails: any signed-in user can read (to gate signup), service role writes.
alter table public.invited_emails enable row level security;
drop policy if exists "Anyone signed-in can read invites" on public.invited_emails;
create policy "Anyone signed-in can read invites" on public.invited_emails
  for select using (auth.uid() is not null);

-- app_secrets: RLS on with NO policies → only service_role (RLS-bypassing) can read.
alter table public.app_secrets enable row level security;

create or replace function public.touch_app_secrets() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;
drop trigger if exists trg_touch_app_secrets on public.app_secrets;
create trigger trg_touch_app_secrets
  before update on public.app_secrets
  for each row execute function public.touch_app_secrets();

-- Hot-path indexes.
create index if not exists ix_subscriptions_next on public.subscriptions(user_id, next_expected_at);
create index if not exists ix_ledger_user_occurred on public.ledger_entries(user_id, occurred_at);
create index if not exists ix_food_user_occurred on public.food_logs(user_id, occurred_at);
create index if not exists ix_wellness_user_occurred on public.wellness_logs(user_id, occurred_at);
create index if not exists ix_workout_user_occurred on public.workout_logs(user_id, occurred_at);
create index if not exists ix_audit_user_created on public.audit_log(user_id, created_at);
-- Smart-matching grouping + soft-delete state (20260625000012).
create index if not exists ix_ledger_event_group on public.ledger_entries(user_id, event_group_id);
create index if not exists ix_food_event_group on public.food_logs(user_id, event_group_id);
create index if not exists ix_ledger_dupe_state on public.ledger_entries(user_id, duplicate_state);
-- Jarvis memory + briefings (20260625000011 / 20260625000014).
create index if not exists ix_memory_facts_user on public.memory_facts(user_id, kind, confidence desc, updated_at desc);
create index if not exists ix_notes_user_status on public.notes(user_id, status, created_at desc);
create index if not exists ix_briefings_user_date on public.briefings(user_id, for_date desc, kind);
create index if not exists ix_habit_days_user_day on public.habit_days(user_id, day desc);
create index if not exists ix_push_subs_user on public.push_subscriptions(user_id);

-- ============================================================================
-- Soft delete (20260806000022). The `deleted_at` columns are declared inline on
-- each table above; this block backfills them on a database created before the
-- migration, adds the partial index every read now matches, and defines the ONLY
-- hard delete in the system. Idempotent - safe to re-run.
--
-- The model gets NO hard-delete path at any risk tier: a delete it asks for is a
-- tombstone, which is what makes "undo the delete" possible at all.
-- ============================================================================
do $softdel$
declare
  t text;
  tables text[] := array[
    'ledger_entries','food_logs','workout_logs','hydration_logs','sleep_sessions',
    'body_metrics','wellness_logs','notes','reminders','user_plans','memory_facts'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', t);
    execute format(
      'create index if not exists ix_%s_live on public.%I (user_id, deleted_at) where deleted_at is null',
      t, t
    );
  end loop;
end$softdel$;

create or replace function public.purge_soft_deleted(older_than_days int default 30)
returns table(table_name text, removed bigint)
language plpgsql
security definer
set search_path = public
as $purge$
declare
  t text;
  tables text[] := array[
    'ledger_entries','food_logs','workout_logs','hydration_logs','sleep_sessions',
    'body_metrics','wellness_logs','notes','reminders','user_plans','memory_facts'
  ];
  n bigint;
begin
  -- A tiny window would turn "soft delete" back into "hard delete with extra
  -- steps". 7 days is the floor; anything below it falls back to 30.
  if older_than_days is null or older_than_days < 7 then
    older_than_days := 30;
  end if;
  foreach t in array tables loop
    execute format(
      'delete from public.%I where deleted_at is not null and deleted_at < now() - ($1 || '' days'')::interval',
      t
    ) using older_than_days;
    get diagnostics n = row_count;
    table_name := t;
    removed := n;
    return next;
  end loop;
end$purge$;

revoke all on function public.purge_soft_deleted(int) from public;
revoke all on function public.purge_soft_deleted(int) from anon, authenticated;

-- ============================================================================
-- Jarvis engine scheduler (20260706000015_jarvis_engine.sql): pg_cron fires
-- jarvis_ping() at three IST slots; it reads JARVIS_CRON_SECRET from app_secrets
-- and pg_net-POSTs to the `jarvis` edge function, which closes out the day,
-- writes habit_days/weekly_reviews/briefings, and delivers email + Web Push.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.jarvis_ping(action text)
returns bigint
language plpgsql
security definer
set search_path = public
as $jping$
declare
  secret text;
  req_id bigint;
begin
  select value into secret from public.app_secrets where name = 'JARVIS_CRON_SECRET';
  if secret is null then
    raise warning 'jarvis_ping: JARVIS_CRON_SECRET missing from app_secrets - skipping %', action;
    return null;
  end if;
  select net.http_post(
    url := 'https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/jarvis',
    body := jsonb_build_object('action', action),
    headers := jsonb_build_object('content-type', 'application/json', 'x-jarvis-secret', secret),
    timeout_milliseconds := 30000
  ) into req_id;
  return req_id;
end$jping$;

revoke all on function public.jarvis_ping(text) from public;
revoke all on function public.jarvis_ping(text) from anon, authenticated;

-- Three IST slots (cron is UTC; IST = UTC+5:30): close-out 00:05 IST, morning
-- brief 07:00 IST, evening nudge 20:30 IST.
do $jcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('jarvis_closeout','jarvis_morning','jarvis_evening')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$jcron$;

select cron.schedule('jarvis_closeout', '35 18 * * *', $$select public.jarvis_ping('closeout')$$);
select cron.schedule('jarvis_morning',  '30 1 * * *',  $$select public.jarvis_ping('morning')$$);
select cron.schedule('jarvis_evening',  '0 15 * * *',  $$select public.jarvis_ping('evening')$$);

-- Live in-app arrival: publish briefings inserts over Supabase Realtime.
do $jpub$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'briefings'
  ) then
    alter publication supabase_realtime add table public.briefings;
  end if;
exception when others then
  -- Realtime is a nice-to-have (live strip refresh); never block the migration.
  raise warning 'could not add briefings to supabase_realtime: %', sqlerrm;
end$jpub$;

-- ============================================================================
-- THE CALENDAR ENGINE (20260806000030_calendar_engine.sql)
--
-- Recurrence modifiers, fire-once claims, and the minute-resolution autonomous
-- scheduler. Asked for out loud: "Calendar is where it will be putting down all
-- its scheduled tasks. And when the scheduled task, it has to trigger on its own
-- and wake up."
-- ============================================================================

-- 1. Recurrence modifiers on `reminders`. Column names dodge two Postgres
--    keywords on purpose - `interval` is a type name, `count` is an aggregate -
--    and lib/reminders.mjs reads either spelling so a DB row can be handed to the
--    engine unmapped.
alter table public.reminders add column if not exists rule_interval int not null default 1;
alter table public.reminders add column if not exists dtstart date;
alter table public.reminders add column if not exists nth_weekday int;   -- 3 = "3rd Tuesday", -1 = "last Friday"
alter table public.reminders add column if not exists weekdays int[];    -- [1,3,5] = Mon/Wed/Fri
alter table public.reminders add column if not exists until date;
alter table public.reminders add column if not exists max_count int;
alter table public.reminders add column if not exists exdates date[];
alter table public.reminders add column if not exists rdates date[];
alter table public.reminders add column if not exists at_time time;      -- NULL = date granularity, said in the 07:00 brief
alter table public.reminders add column if not exists timezone text;     -- NULL = the profile's zone
-- reminders.last_fired_on is DEPRECATED: never read or written by any code, and a
-- date cannot express two fires in one day. reminder_fires is the claim of record.

-- 2. reminder_fires - the claim that makes a fire happen exactly once.
--    The INSERT *is* the claim: two schedulers race the same occurrence, one
--    wins, the loser gets a unique violation and treats it as a successful
--    no-op. Before this, a reminder inside its lead window re-fired every day -
--    GST at lead_days=7 was eight identical morning pushes, which is how a
--    person learns to swipe away every notification the app sends.
create table if not exists public.reminder_fires (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  occurrence_key text not null,             -- occurrenceKey(): "2026-08-14" or "2026-08-14T18:30"
  channel text not null default 'push',     -- push_lead | push_due | push_timed
  fired_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  constraint reminder_fires_once unique (reminder_id, occurrence_key, channel)
);
create index if not exists ix_reminder_fires_user on public.reminder_fires(user_id, fired_at desc);

-- 3. job_runs - the generalised slot claim with a stale lease, so pg_cron and the
--    GitHub heartbeat COLLIDE rather than double-fire, and a crashed run releases
--    its slot after the lease instead of wedging it forever.
create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job text not null,
  slot_key text not null,
  status text not null default 'running' check (status in ('running','done','failed')),
  attempts int not null default 1,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  detail jsonb not null default '{}'::jsonb,
  constraint job_runs_slot_once unique (user_id, job, slot_key)
);
create index if not exists ix_job_runs_claimed on public.job_runs(job, claimed_at desc);

-- 4. agent_tasks - what the agent scheduled for itself, plus one row per run.
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  fire_at timestamptz not null,
  tz text not null default 'Asia/Kolkata',
  recurrence jsonb,                          -- a lib/reminders.mjs rule, or NULL for a one-shot
  intent text not null default 'check' check (intent in ('check','answer','remind','review')),
  prompt text not null,
  created_by text not null default 'user' check (created_by in ('user','agent','system')),
  status text not null default 'scheduled' check (status in ('scheduled','running','done','failed','disabled')),
  origin_ingestion_id uuid references public.raw_ingestions(id) on delete set null,
  dedupe_key text,
  depth int not null default 0 check (depth between 0 and 3),   -- a task may not create a task
  claimed_at timestamptz,
  last_run_at timestamptz,
  runs int not null default 0,
  consecutive_failures int not null default 0,                  -- 3 trips a visible breaker
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_agent_tasks_dedupe on public.agent_tasks(user_id, dedupe_key) where dedupe_key is not null;
create index if not exists ix_agent_tasks_due on public.agent_tasks(fire_at) where status = 'scheduled';
create index if not exists ix_agent_tasks_user on public.agent_tasks(user_id, fire_at desc);

create table if not exists public.agent_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  slot_key text not null,                    -- the claim: unique per (task, occurrence)
  status text not null default 'claimed' check (status in ('claimed','silent','spoke','failed','blocked')),
  result text,                               -- 'silent: on track' is a real outcome, logged as one
  action_hash text,                          -- same (task, hash) 3x in 24h = a loop
  actions int not null default 0,
  -- Autonomous spend is accounted HERE and never in ai_runs, so a background
  -- agent can consume neither the human's 60-per-5-min rate limit nor their
  -- $2/day cap and lock them out of their own app.
  cost_usd numeric(12,6) not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint agent_task_runs_once unique (task_id, slot_key)
);
create index if not exists ix_agent_task_runs_user on public.agent_task_runs(user_id, started_at desc);
create index if not exists ix_agent_task_runs_hash on public.agent_task_runs(task_id, action_hash, started_at desc);

-- 5. Autonomy governance flags. autonomy_enabled is read SERVER-SIDE, FIRST, and
--    fails CLOSED: a client flag cannot stop a server-side agent, and an
--    unreadable flag must never read as permission.
alter table public.profiles add column if not exists autonomy_enabled boolean not null default false;
alter table public.profiles add column if not exists autonomy_daily_cost_usd numeric(8,4) not null default 0.25;

-- 6. RLS for the new tables ('reminder_fires','job_runs','agent_tasks','agent_task_runs').
do $calrls$
declare t text;
begin
  for t in select unnest(array['reminder_fires','job_runs','agent_tasks','agent_task_runs'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$calrls$;

-- 7. Claim helpers. See the migration for the full reasoning; the load-bearing
--    detail is `fire_at <= now()` (never `=`) so a minute the scheduler missed
--    still fires late, and FOR UPDATE SKIP LOCKED so two schedulers arriving
--    together take DIFFERENT rows.
create or replace function public.claim_job(
  p_user uuid, p_job text, p_slot text, p_lease_seconds int default 600
) returns boolean
language plpgsql security definer set search_path = public
as $claim$
declare got boolean;
begin
  insert into public.job_runs (user_id, job, slot_key, status, claimed_at)
  values (p_user, p_job, p_slot, 'running', now())
  on conflict (user_id, job, slot_key) do update
     set claimed_at = now(), status = 'running', attempts = public.job_runs.attempts + 1
   where public.job_runs.status <> 'done'
     and public.job_runs.claimed_at < now() - make_interval(secs => p_lease_seconds)
  returning true into got;
  return coalesce(got, false);
end$claim$;

create or replace function public.finish_job(p_user uuid, p_job text, p_slot text, p_status text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public
as $finish$
  update public.job_runs
     set status = case when p_status in ('done','failed') then p_status else 'done' end,
         finished_at = now(), detail = coalesce(p_detail, '{}'::jsonb)
   where user_id = p_user and job = p_job and slot_key = p_slot;
$finish$;

create or replace function public.claim_agent_tasks(p_user uuid, p_limit int default 5)
returns setof public.agent_tasks
language plpgsql security definer set search_path = public
as $claimtasks$
begin
  update public.agent_tasks
     set status = 'scheduled', updated_at = now()
   where user_id = p_user and status = 'running'
     and claimed_at is not null and claimed_at < now() - interval '10 minutes';

  return query
  with picked as (
    select id from public.agent_tasks
     where user_id = p_user and status = 'scheduled' and fire_at <= now()
     order by fire_at
     for update skip locked
     limit greatest(1, least(p_limit, 20))
  )
  update public.agent_tasks t
     set status = 'running', claimed_at = now(), updated_at = now()
    from picked
   where t.id = picked.id
  returning t.*;
end$claimtasks$;

revoke all on function public.claim_job(uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.finish_job(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_agent_tasks(uuid, int) from public, anon, authenticated;

-- 8. The minute clock. Every minute, not every 5: a reminder set for 18:30 that
--    fires at 18:34 is a different product. The tick is SILENT by design - with
--    nothing due it is two indexed queries per profile and writes nothing.
do $caljcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'jarvis_tasks'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$caljcron$;

select cron.schedule('jarvis_tasks', '* * * * *', $jt$select public.jarvis_ping('task')$jt$);

-- ============================================================================
-- GOOGLE CALENDAR SYNC (20260806000040_gcal_sync.sql)
--
-- Mirrored here because tests/schema-contract.test.mjs requires schema.sql to be
-- the single source of truth: every table a migration creates must also be
-- defined here. The migration carries the full reasoning; the short version:
--
--   * We write ONLY to a calendar we created ourselves (the OAuth grant uses
--     `calendar.app.created`, which cannot reach the user's real calendars).
--   * Everything we read from their other calendars lands in
--     calendar_events_raw, read-only, and nothing writes back.
--   * A remote delete is ONLY ever an explicit tombstone. Never inferred from
--     absence - a dropped sync token and a deleted event look identical, and
--     acting on the second interpretation wipes calendars.
--   * Three loop guards, all of them: local_hash/remote_hash (content),
--     etag (version echo) and the X-TRACKERZ-ORIGIN extended property
--     (authorship). lib/gcal-sync.mjs argues why no two are enough.
--   * Refresh tokens live in calendar_secrets, which uses the app_secrets
--     posture exactly: RLS on, NO policies, so only service_role can read it.
--   * sync_broken_since exists because the failure mode of this integration is
--     an EMPTY CALENDAR that looks fine, not an error page.
-- ============================================================================

create table if not exists public.calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'google'
    check (provider in ('google', 'microsoft', 'caldav', 'ics')),
  external_account_email text,
  calendar_id text,
  calendar_summary text,
  sync_token text,
  sync_token_updated_at timestamptz,
  last_full_sync_at timestamptz,
  mirror_calendar_id text not null default 'primary',
  mirror_sync_token text,
  channel_id text,
  channel_resource_id text,
  channel_expiry timestamptz,
  scopes text[] not null default '{}'::text[],
  status text not null default 'connected'
    check (status in ('connected', 'disconnected', 'needs_reauth')),
  last_sync_at timestamptz,
  last_push_at timestamptz,
  sync_broken_since timestamptz,
  sync_broken_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_accounts_identity unique (user_id, provider, external_account_email)
);
alter table public.calendar_accounts add column if not exists mirror_calendar_id text not null default 'primary';
alter table public.calendar_accounts add column if not exists mirror_sync_token text;
create index if not exists ix_calendar_accounts_user on public.calendar_accounts(user_id, provider);
create index if not exists ix_calendar_accounts_channel on public.calendar_accounts(channel_id) where channel_id is not null;
create index if not exists ix_calendar_accounts_renew on public.calendar_accounts(channel_expiry) where status = 'connected';

create table if not exists public.calendar_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.calendar_accounts(id) on delete cascade,
  reminder_id uuid references public.reminders(id) on delete cascade,
  event_id text not null,
  calendar_id text,
  etag text,
  local_hash text,
  remote_hash text,
  origin text not null default 'local' check (origin in ('local', 'remote')),
  last_pushed_at timestamptz,
  last_pulled_at timestamptz,
  remote_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_links_event_once unique (account_id, event_id)
);
create unique index if not exists ux_calendar_links_reminder
  on public.calendar_links(account_id, reminder_id) where reminder_id is not null;
create index if not exists ix_calendar_links_user on public.calendar_links(user_id, updated_at desc);

create table if not exists public.calendar_events_raw (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.calendar_accounts(id) on delete cascade,
  calendar_id text not null,
  event_id text not null,
  etag text,
  status text,
  summary text,
  description text,
  location text,
  organizer_email text,
  attendees jsonb not null default '[]'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  all_day boolean not null default false,
  start_date date,
  recurrence text[],
  recurring_event_id text,
  html_link text,
  tombstoned_at timestamptz,
  remote_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint calendar_events_raw_once unique (account_id, event_id)
);
create index if not exists ix_calendar_events_raw_window
  on public.calendar_events_raw(user_id, starts_at) where tombstoned_at is null;
create index if not exists ix_calendar_events_raw_account
  on public.calendar_events_raw(account_id, last_seen_at desc);

create table if not exists public.calendar_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.calendar_accounts(id) on delete cascade,
  reason text not null default 'webhook' check (reason in ('webhook', 'manual', 'cron', 'reconnect')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  resource_state text,
  message_number bigint,
  attempts int not null default 0,
  claimed_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create unique index if not exists ux_calendar_sync_jobs_pending
  on public.calendar_sync_jobs(account_id) where status = 'pending';
create index if not exists ix_calendar_sync_jobs_user on public.calendar_sync_jobs(user_id, created_at desc);

-- calendar_secrets / calendar_oauth_states: the app_secrets posture. RLS ON with
-- NO POLICIES denies every role that respects RLS and leaves only the
-- RLS-bypassing service_role, which exists solely inside the edge function. Do
-- not add an owner policy here - the owner is a browser, and a browser must
-- never be able to read a refresh token.
create table if not exists public.calendar_secrets (
  account_id uuid primary key references public.calendar_accounts(id) on delete cascade,
  refresh_token text,
  access_token text,
  access_token_expires_at timestamptz,
  channel_token text,
  updated_at timestamptz not null default now()
);
alter table public.calendar_secrets enable row level security;
revoke all on table public.calendar_secrets from anon, authenticated;

create table if not exists public.calendar_oauth_states (
  state text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'google',
  redirect_to text,
  scopes text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);
alter table public.calendar_oauth_states enable row level security;
revoke all on table public.calendar_oauth_states from anon, authenticated;
create index if not exists ix_calendar_oauth_states_expiry on public.calendar_oauth_states(expires_at);

create or replace function public.claim_calendar_sync_jobs(p_limit int default 10)
returns setof public.calendar_sync_jobs
language plpgsql security definer set search_path = public
as $claimcal$
begin
  update public.calendar_sync_jobs
     set status = 'pending'
   where status = 'running' and claimed_at is not null and claimed_at < now() - interval '10 minutes';

  return query
  with picked as (
    select id from public.calendar_sync_jobs
     where status = 'pending'
     order by created_at
     for update skip locked
     limit greatest(1, least(p_limit, 50))
  )
  update public.calendar_sync_jobs j
     set status = 'running', claimed_at = now(), attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.*;
end$claimcal$;

revoke all on function public.claim_calendar_sync_jobs(int) from public, anon, authenticated;

-- RLS. calendar_accounts is FULL (the user connects and disconnects it). The
-- other three are SELECT-only from the browser: they are written by the edge
-- function under the service role, and a browser that can UPDATE a sync_token or
-- a tombstone can corrupt the sync in ways no test would catch.
alter table public.calendar_accounts enable row level security;
drop policy if exists "Users manage own rows" on public.calendar_accounts;
create policy "Users manage own rows" on public.calendar_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $calrls$
declare t text;
begin
  for t in select unnest(array['calendar_links', 'calendar_events_raw', 'calendar_sync_jobs'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format('drop policy if exists "Users read own rows" on public.%I', t);
    execute format('create policy "Users read own rows" on public.%I for select using (auth.uid() = user_id)', t);
  end loop;
end$calrls$;

-- The scheduler rails. gcal_drain every 5 minutes runs whatever the webhook
-- enqueued PLUS a safety-net poll for accounts whose push channel died without
-- telling us; gcal_renew re-registers watch channels daily, because Google
-- expires them at ~30 days and does not renew them - a calendar with no renew
-- job goes quiet exactly one month after it starts working.
create or replace function public.gcal_ping(action text)
returns bigint
language plpgsql security definer set search_path = public
as $gping$
declare
  secret text;
  req_id bigint;
begin
  select value into secret from public.app_secrets where name = 'JARVIS_CRON_SECRET';
  if secret is null then
    raise warning 'gcal_ping: JARVIS_CRON_SECRET missing from app_secrets - skipping %', action;
    return null;
  end if;
  select net.http_post(
    url := 'https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/gcal',
    body := jsonb_build_object('action', action),
    headers := jsonb_build_object('content-type', 'application/json', 'x-jarvis-secret', secret),
    timeout_milliseconds := 60000
  ) into req_id;
  return req_id;
end$gping$;

revoke all on function public.gcal_ping(text) from public, anon, authenticated;

do $gcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('gcal_drain', 'gcal_renew')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$gcron$;

select cron.schedule('gcal_drain', '*/5 * * * *', $gd$select public.gcal_ping('drain')$gd$);
select cron.schedule('gcal_renew', '50 20 * * *', $gr$select public.gcal_ping('renew')$gr$);

notify pgrst, 'reload schema';
