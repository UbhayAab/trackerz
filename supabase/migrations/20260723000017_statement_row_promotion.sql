-- Make imported bank statements reachable by the ledger, and make a re-import
-- of the same statement a no-op.
--
-- Two production defects this closes:
--
-- 1. statement_rows was write-only. Rows were stored and nothing ever promoted
--    them into ledger_entries, so every rupee of imported bank data was missing
--    from every money total in the app while the import UI reported success.
--
-- 2. The dedupe key was unique(user_id, import_id, row_hash). import_id is
--    freshly minted on every upload, so the key could never collide: importing
--    the same statement twice inserted the whole file twice. content_key drops
--    import_id and keys on what the bank actually said happened.
--
-- NOT APPLIED. Run `npm run db:push` deliberately. Idempotent.

-- 1. Stable content identity ------------------------------------------------
alter table public.statement_rows add column if not exists content_key text;

-- Promotion state. ledger_entry_id (already present) is the marker that a row
-- reached the ledger; these two record when, and why it could not.
alter table public.statement_rows add column if not exists promoted_at timestamptz;
alter table public.statement_rows add column if not exists promotion_error text;

-- Backfill mirrors statementRowKey() + assignContentKeys() in
-- src/imports/row-normalizer.js: date|debit|credit|reference-or-description,
-- with a #n suffix on repeats so two genuinely identical transactions on one day
-- both keep a row. Keep the two in step if either changes.
with keyed as (
  select
    id,
    coalesce(to_char(occurred_on, 'YYYY-MM-DD'), 'nodate') || '|' ||
    coalesce(to_char(abs(debit), 'FM9999999990.00'), '') || '|' ||
    coalesce(to_char(abs(credit), 'FM9999999990.00'), '') || '|' ||
    left(btrim(regexp_replace(lower(coalesce(nullif(reference, ''), description, '')), '[^a-z0-9]+', ' ', 'g')), 80)
      as base,
    user_id
  from public.statement_rows
  where content_key is null
),
numbered as (
  select id, base, row_number() over (partition by user_id, base order by id) as n
  from keyed
)
update public.statement_rows sr
set content_key = case when n.n = 1 then n.base else n.base || '#' || n.n end
from numbered n
where sr.id = n.id;

-- NOT a partial index. Postgres cannot use a partial index as an ON CONFLICT
-- arbiter unless the statement repeats the same predicate, so `where content_key
-- is not null` made every import fail with 42P10 (verified against the live DB).
-- content_key is generated for every row anyway, so the predicate bought nothing.
create unique index if not exists ux_statement_rows_user_content
  on public.statement_rows(user_id, content_key);

-- 2. Drop the key that guaranteed a miss ------------------------------------
-- It also had a second cost: two identical transactions inside ONE file share a
-- row_hash, so the ignoreDuplicates upsert silently dropped the second one and
-- under-counted the user's spending. content_key's #n suffix keeps both.
alter table public.statement_rows drop constraint if exists statement_rows_user_id_import_id_row_hash_key;

-- 3. Read paths -------------------------------------------------------------
create index if not exists ix_statement_rows_unpromoted
  on public.statement_rows(user_id, import_id) where ledger_entry_id is null;

-- The promoter looks up already-present statement-sourced entries by day.
create index if not exists ix_ledger_source_occurred
  on public.ledger_entries(user_id, source_type, occurred_at);

-- NOTE: schema.sql is the single source of truth for table shape; mirror these
-- three statement_rows columns there when this migration is applied.
