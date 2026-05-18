-- Adds discretionary/essential classification on ledger_entries,
-- and a Nifty 50 monthly close reference table for the
-- opportunity-cost insight.

alter table public.ledger_entries
  add column if not exists is_discretionary boolean not null default false;

alter table public.ledger_entries
  add column if not exists tags text[] not null default '{}';

-- Nifty 50 historical monthly closes. Seeded by the app, not per-user.
create table if not exists public.nifty_monthly_closes (
  month date primary key,
  close numeric(14,2) not null
);

alter table public.nifty_monthly_closes enable row level security;

drop policy if exists "Anyone can read nifty closes" on public.nifty_monthly_closes;
create policy "Anyone can read nifty closes" on public.nifty_monthly_closes
  for select using (true);
