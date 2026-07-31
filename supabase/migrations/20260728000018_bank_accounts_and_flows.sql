-- Bank accounts, transaction flow types, and the links between rows.
--
-- Three things the ledger could not previously express, all of which a real
-- bank statement forces on you:
--
-- 1. WHICH ACCOUNT. Without it, money the user moves between their own two
--    banks is indistinguishable from money leaving. Across the user's HDFC and
--    Kotak statements that is Rs 1.4 lakh of pure double-counting.
-- 2. WHAT KIND OF MOVEMENT. `direction in (expense, income, transfer)` cannot
--    tell a credit-card bill payment from a grocery run, or a mutual-fund
--    purchase from rent. HDFC reports Rs 8.26 lakh of "debits" for six months;
--    the part that is actually consumption is a small fraction of it.
-- 3. WHAT IS PAIRED WITH WHAT. A refund is only a refund relative to the debit
--    it reverses, and a transfer is one event recorded twice.

-- The user's own accounts. Learned from imported statements rather than typed
-- in: this is what lets a payment to KKBK0008109 be recognised as a self
-- transfer the moment the Kotak statement has been seen once.
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
  -- Balance as of the newest statement seen, plus the date it was true on.
  -- A balance without its date is a number that quietly rots.
  last_balance numeric(14,2),
  last_balance_on date,
  -- Every UPI handle seen paying into or out of this account, so the next
  -- statement recognises the user's own VPAs.
  vpas text[] not null default '{}',
  is_own boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- An account number is unique per user; a masked one (XXXX9097) may not be, so
-- the index tolerates nulls and the importer falls back to (bank, last4).
create unique index if not exists ux_bank_accounts_user_number
  on public.bank_accounts(user_id, account_number) where account_number is not null;
create index if not exists ix_bank_accounts_user on public.bank_accounts(user_id);

alter table public.ledger_entries
  add column if not exists account_id uuid references public.bank_accounts(id) on delete set null,
  -- The semantic kind of movement. `direction` stays as it was so nothing that
  -- reads it breaks; flow_type is the finer truth layered on top.
  add column if not exists flow_type text,
  add column if not exists counterparty text,
  add column if not exists counterparty_vpa text,
  add column if not exists rail text,
  add column if not exists balance_after numeric(14,2),
  -- False for transfers, investments and card bill payments: money that moved
  -- without being spent. Every spending total should filter on this.
  add column if not exists counts_as_spending boolean not null default true,
  add column if not exists counts_as_income boolean not null default false,
  add column if not exists classification_confidence numeric(5,4),
  add column if not exists classification_reasons text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_entries_flow_type_check') then
    alter table public.ledger_entries add constraint ledger_entries_flow_type_check
      check (flow_type is null or flow_type in (
        'spend','income','p2p_out','p2p_in',
        'self_transfer_out','self_transfer_in',
        'investment','investment_return',
        'card_payment','loan_emi','loan_principal','loan_disbursal',
        'refund','bank_charge','interest','wallet_load','cash',
        'unknown_out','unknown_in'
      ));
  end if;
end$$;

create index if not exists ix_ledger_flow on public.ledger_entries(user_id, flow_type);
create index if not exists ix_ledger_account on public.ledger_entries(user_id, account_id, occurred_at);
create index if not exists ix_ledger_spending on public.ledger_entries(user_id, occurred_at)
  where counts_as_spending;

-- Pairs of entries that are one real event or one cancelling the other.
-- Kept as its own table rather than a column, because a refund of a
-- triple-charge points at THREE debits, and the reason for every link has to
-- survive so a wrong one can be found and undone.
create table if not exists public.ledger_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('self_transfer','refund','duplicate_charge','manual_match')),
  from_entry_id uuid references public.ledger_entries(id) on delete cascade,
  to_entry_id uuid references public.ledger_entries(id) on delete cascade,
  amount numeric(14,2),
  confidence numeric(5,4) not null default 1,
  reason text,
  -- 'applied' actually changed the entries; 'suggested' is waiting on the user.
  state text not null default 'applied' check (state in ('suggested','applied','rejected')),
  created_at timestamptz not null default now()
);
create unique index if not exists ux_ledger_links_pair
  on public.ledger_links(user_id, kind, from_entry_id, to_entry_id);
create index if not exists ix_ledger_links_user on public.ledger_links(user_id, kind, state);

-- Recurring series detected from history, so a MISSING instance can be noticed.
-- The user's Rs 29,057 EMI ran for five months and then stopped, which is only
-- visible if something was expecting the sixth.
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

-- Statement rows gain the account they belong to and the audit verdict, so a
-- statement whose parse could not be verified is never silently trusted later.
alter table public.statement_rows
  add column if not exists account_id uuid references public.bank_accounts(id) on delete set null,
  add column if not exists txn_time text,
  add column if not exists flow_type text,
  add column if not exists counterparty text;

alter table public.statement_imports
  add column if not exists account_id uuid references public.bank_accounts(id) on delete set null,
  add column if not exists period_from date,
  add column if not exists period_to date,
  -- proven | consistent | suspect - see lib/statement-audit.mjs
  add column if not exists audit_confidence text,
  add column if not exists audit_summary text,
  add column if not exists audit_failures text[] not null default '{}',
  add column if not exists declared_totals jsonb,
  add column if not exists computed_totals jsonb;

alter table public.bank_accounts enable row level security;
alter table public.ledger_links enable row level security;
alter table public.recurring_series enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['bank_accounts','ledger_links','recurring_series'])
  loop
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format(
      'create policy "Users manage own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end$$;
