-- Single source of truth for budgets/goals: a stable `kind` key + one row per
-- (user, kind) so editing a budget upserts the canonical row and propagates
-- everywhere (Home, Money, Diet targets, insights). No duplicate budget rows.
alter table public.budgets add column if not exists kind text;
create unique index if not exists budgets_user_kind_uniq on public.budgets (user_id, kind);
