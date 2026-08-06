-- AMENDING A LOG THAT ALREADY EXISTS (20260806000070).
--
-- The model can now UPDATE and DELETE rows (amend_log_candidate /
-- delete_log_candidate). Soft delete already landed in 20260806000022; this
-- migration adds the two things that were still missing before those tools could
-- honestly ship.
--
-- 1. AN AUDIT ROW THAT IS NEVER ITSELF DELETED.
--
--    `audit_log` had ONE policy - "Users manage own rows" FOR ALL - so anything
--    holding a user JWT could delete the record of what had been changed. That
--    is not an audit log, it is a note. The bug it is supposed to prevent has
--    already happened once in this codebase: revertTargetEvent used to DELETE
--    the audit row it undid, so after an undo the app held no record that the
--    target had ever changed and none that it had been changed back. The code
--    was fixed; the door it walked through stayed open.
--
--    Now: SELECT and INSERT only. No UPDATE policy and no DELETE policy exists
--    for `authenticated`, so with RLS on, both are refused by the database
--    rather than by a convention.
--
--    The one legitimate erasure - a user asking to be forgotten - goes through
--    erase_audit_log(), a named SECURITY DEFINER function that removes only the
--    caller's own rows. A single door with a name on it, instead of a standing
--    permission nobody remembers granting.
--
-- 2. THE INDEX BEHIND THE PER-DAY DELETE BUDGET. The agent counts how many
--    deletes it has already been offered in a rolling 24 hours before it will
--    resolve another one. That query runs on every capture that carries a
--    delete, so it gets an index rather than a sequential scan of ai_actions.
--
-- Idempotent: safe to re-run against a live database.

-- ---- 1. append-only audit log ---------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists "Users manage own rows" on public.audit_log;
drop policy if exists "audit_log_select_own" on public.audit_log;
drop policy if exists "audit_log_insert_own" on public.audit_log;

create policy "audit_log_select_own" on public.audit_log
  for select using (auth.uid() = user_id);

create policy "audit_log_insert_own" on public.audit_log
  for insert with check (auth.uid() = user_id);

-- No FOR UPDATE and no FOR DELETE policy. Their absence IS the control - adding
-- one back is the thing a reviewer should have to justify.

create or replace function public.erase_audit_log()
returns bigint
language plpgsql
security definer
set search_path = public
as $erase$
declare
  n bigint;
begin
  if auth.uid() is null then
    raise exception 'erase_audit_log requires an authenticated caller';
  end if;
  delete from public.audit_log where user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end$erase$;

revoke all on function public.erase_audit_log() from public;
grant execute on function public.erase_audit_log() to authenticated;

-- ---- 2. the delete-budget counter -----------------------------------------
create index if not exists ix_ai_actions_tool_recent
  on public.ai_actions (user_id, tool_name, created_at desc);

-- ---- 3. finding an amended row's history ----------------------------------
-- Every amend and delete writes `ai_amend_log` / `ai_delete_log` naming the row
-- it touched. Without this index, "what happened to this entry" is a scan.
create index if not exists ix_audit_target
  on public.audit_log (user_id, target_table, target_id, created_at desc);

notify pgrst, 'reload schema';
