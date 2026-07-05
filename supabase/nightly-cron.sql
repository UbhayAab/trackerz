-- Registers the twice-daily proactive-brain schedule. NOT a migration: run this
-- ONCE (SQL editor or scripts/db-push won't pick it up) AFTER
--   1. the `nightly` edge function is deployed, and
--   2. app_secrets has a NIGHTLY_SECRET row (see docs/jarvis-deploy.md).
-- Re-running is safe — jobs are replaced by name.
--
-- Times are UTC: 01:30 UTC = 07:00 IST (morning briefing), 14:30 UTC = 20:00 IST
-- (evening check-in). The function itself resolves each user's timezone; these
-- fire times just pick sensible IST wall-clock moments for the push.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace-by-name: unschedule quietly if the job already exists.
do $$
begin
  perform cron.unschedule('trackerz-briefing-morning');
exception when others then null;
end$$;

do $$
begin
  perform cron.unschedule('trackerz-briefing-evening');
exception when others then null;
end$$;

select cron.schedule(
  'trackerz-briefing-morning',
  '30 1 * * *',
  $cmd$
  select net.http_post(
    url := 'https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/nightly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-nightly-secret', (select value from public.app_secrets where name = 'NIGHTLY_SECRET')
    ),
    body := jsonb_build_object('slot', 'morning'),
    timeout_milliseconds := 30000
  );
  $cmd$
);

select cron.schedule(
  'trackerz-briefing-evening',
  '30 14 * * *',
  $cmd$
  select net.http_post(
    url := 'https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/nightly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-nightly-secret', (select value from public.app_secrets where name = 'NIGHTLY_SECRET')
    ),
    body := jsonb_build_object('slot', 'evening'),
    timeout_milliseconds := 30000
  );
  $cmd$
);

-- Verify: select jobid, jobname, schedule from cron.job;
-- Watch runs: select * from cron.job_run_details order by start_time desc limit 10;
-- Watch HTTP results: select * from net._http_response order by created desc limit 10;
