-- Smart matching: give ledger_entries the columns the dedupe-matrix engine needs
-- (hard reference, source provenance for survivorship, account for transfers) plus
-- cross-domain/transitive grouping + soft-delete merge state. food_logs only needs
-- the grouping key (a meal is linked to a spend, never merged into it).
-- duplicate_state stays free-text: 'unique' | 'duplicate_loser' | 'linked'.

alter table public.ledger_entries add column if not exists source_type text;       -- bank|file|image|audio|text|mixed (survivorship rank)
alter table public.ledger_entries add column if not exists reference text;          -- UPI ref / UTR / external ref (hard-dup signal)
alter table public.ledger_entries add column if not exists account text;            -- transfer detection (different account)
alter table public.ledger_entries add column if not exists event_group_id uuid;     -- transitive "one real event" cluster id
alter table public.ledger_entries add column if not exists merged_into uuid references public.ledger_entries(id) on delete set null;

alter table public.food_logs add column if not exists event_group_id uuid;

create index if not exists ix_ledger_event_group on public.ledger_entries(user_id, event_group_id);
create index if not exists ix_food_event_group   on public.food_logs(user_id, event_group_id);
create index if not exists ix_ledger_dupe_state   on public.ledger_entries(user_id, duplicate_state);
