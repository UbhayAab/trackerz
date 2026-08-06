-- TASK QUEUE HARDENING
--
-- `claim_agent_tasks` shipped this morning and is correct in the part everyone
-- checks - `FOR UPDATE SKIP LOCKED` on the pick, which is byte-for-byte the
-- pattern pgmq uses. The four defects below are all in the RECOVERY path, which
-- is the part nobody exercises until something has already gone wrong.
--
-- The one that matters most is the third. The breaker that is supposed to stop a
-- runaway task lives in the edge function and reads `consecutive_failures`. The
-- crash-recovery reset never touches that column. So a task that kills the
-- FUNCTION - an OOM, a timeout, a throw outside the try - is reset to
-- 'scheduled' with its failure count still at zero, claimed again, and crashes
-- again, every ten minutes, forever. The three-strikes breaker cannot fire
-- because nothing is counting the strikes. The app would be quietly burning a
-- function invocation every ten minutes with no row, no error and no way to
-- notice, which is the same silent-failure family this whole audit is about.
--
-- Verified NOT a defect, so it is not "fixed" here: pg_net's 2000 ms default
-- timeout does not apply - `jarvis_ping` passes `timeout_milliseconds := 30000`
-- explicitly, and the gcal ping passes 60000.

-- ---------------------------------------------------------------------------
-- 1. An index the RESET can use
-- ---------------------------------------------------------------------------
-- `ix_agent_tasks_due` is partial on `status = 'scheduled'`, so the reset's
-- `where status = 'running' and claimed_at < ...` matches none of it and falls
-- back to a sequential scan. That is nothing today and is a scan of the whole
-- table on every minute tick once this table has history.
create index if not exists ix_agent_tasks_stuck
  on public.agent_tasks(claimed_at) where status = 'running';

-- ---------------------------------------------------------------------------
-- 2-4. A recovery path that counts, backs off, and does not block
-- ---------------------------------------------------------------------------
create or replace function public.claim_agent_tasks(p_user uuid, p_limit int default 5)
returns setof public.agent_tasks
language plpgsql
security definer
set search_path = public
as $claimtasks$
declare
  v_max_failures constant int := 3;
begin
  -- RECOVERY. Anything left 'running' past the lease died without reporting.
  --
  -- (a) SKIP LOCKED. The old reset was a bare UPDATE, so two minute-ticks
  --     overlapping - which happens the moment one run takes longer than 60s -
  --     had the second block on the first's row locks instead of moving on.
  --     A queue drainer that can be blocked by another drainer is not one.
  --
  -- (b) A CRASH IS A FAILURE. It is counted, so the existing three-strikes
  --     breaker can actually see it. This is the fix that stops a
  --     crash-reset-crash loop running unnoticed forever.
  --
  -- (c) BACKOFF. `order by fire_at` means the oldest due task is always picked
  --     first, so a task that fails instantly sits at the head of the queue and
  --     is re-picked every single minute, starving everything behind it. Pushing
  --     fire_at forward 2^n minutes turns a poison task into a quiet one.
  --
  -- (d) The breaker is enforced HERE, in SQL, and not only in the edge function.
  --     A task that crashes the function never reaches the function's copy of the
  --     rule, so a breaker that only exists there cannot stop the one failure
  --     mode it is most needed for.
  with stuck as (
    select id from public.agent_tasks
     where user_id = p_user
       and status = 'running'
       and claimed_at is not null
       and claimed_at < now() - interval '10 minutes'
     for update skip locked
  )
  update public.agent_tasks t
     set consecutive_failures = t.consecutive_failures + 1,
         status = case
           when t.consecutive_failures + 1 >= v_max_failures then 'disabled'
           else 'scheduled'
         end,
         disabled_reason = case
           when t.consecutive_failures + 1 >= v_max_failures
             then 'the run crashed ' || (t.consecutive_failures + 1)
                  || ' times without reporting - switched off, re-enable in Settings'
           else t.disabled_reason
         end,
         -- 2, 4, 8 minutes. Bounded by the breaker above, so this can never
         -- become an unbounded silent retreat into the future.
         fire_at = case
           when t.consecutive_failures + 1 >= v_max_failures then t.fire_at
           else greatest(t.fire_at, now()) + (power(2, t.consecutive_failures + 1) * interval '1 minute')
         end,
         claimed_at = null,
         updated_at = now()
    from stuck
   where t.id = stuck.id;

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

revoke all on function public.claim_agent_tasks(uuid, int) from public, anon, authenticated;

notify pgrst, 'reload schema';
