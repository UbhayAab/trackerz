-- SOFT DELETE for every table the LLM can reach (20260806000022).
--
-- Why: the next phase gives the model the power to EDIT and DELETE rows, and a
-- hard delete has no undo. There is nothing to put back, no before-image, and no
-- way to tell "the user removed it" from "the model removed it by mistake". A
-- tombstone makes the delete a normal, reversible write: reads filter
-- `deleted_at is null`, undo clears the column, and the row is only really gone
-- after the 30-day purge - which is maintenance, not something the model can ask
-- for. The model gets NO hard-delete path at any risk tier.
--
-- Idempotent: `add column if not exists` + `create index if not exists`, so it is
-- safe to re-run and safe to apply on top of a database that already has some of
-- these columns.
--
-- PostgREST note: the first live read after this DDL can fail with PGRST204
-- ("column ... does not exist in the schema cache") until PostgREST reloads. The
-- notify at the bottom asks for that reload; if a read still 204s, wait a beat
-- and retry rather than concluding the column is missing.

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
    -- Partial index on the live rows: every read in the app now carries
    -- `deleted_at is null`, so this is the shape of every hot query.
    execute format(
      'create index if not exists ix_%s_live on public.%I (user_id, deleted_at) where deleted_at is null',
      t, t
    );
  end loop;
end$softdel$;

-- The ONLY hard delete. Maintenance, run manually or from a scheduled job -
-- never reachable from a tool call. Returns how many rows it removed per table.
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
  -- A negative or absurdly small window would turn "soft delete" back into "hard
  -- delete with extra steps". 7 days is the floor.
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

notify pgrst, 'reload schema';
