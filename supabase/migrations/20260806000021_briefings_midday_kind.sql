-- Let the midday slot actually store its briefing.
--
-- 20260731000019 added the fourth Jarvis slot: it unscheduled and rescheduled
-- `jarvis_midday` in pg_cron, and the edge function grew a runMidday(). What it
-- did NOT do is widen `briefings.kind`, which still only permitted
-- ('morning','evening','closeout','weekly').
--
-- So the slot was broken twice over, in two different layers, and neither
-- failure was visible:
--
--   1. `"midday"` was missing from the action allowlist in the jarvis function,
--      so every pg_cron and GitHub-heartbeat call returned 400 unknown_action
--      before reaching runMidday at all. pg_net is fire-and-forget so nothing
--      surfaced it, and the heartbeat workflow piped the body to `head` and
--      exited 0, so the run went green.
--   2. Underneath that, this check constraint would have rejected the upsert
--      anyway.
--
-- Measured before the fix: `select kind, count(*) from briefings group by kind`
-- returned 50 morning, 50 closeout, 50 evening, 8 weekly and ZERO midday. The
-- 14:30 IST protein/gym pace check has never produced a row in its life - which
-- is exactly the "computed, deployed, wired to a cron, silently never runs"
-- failure this codebase keeps repeating.
--
-- Idempotent: drop-if-exists then re-add, so re-running is safe.

alter table public.briefings drop constraint if exists briefings_kind_check;

alter table public.briefings
  add constraint briefings_kind_check
  check (kind in ('morning','midday','evening','closeout','weekly'));
