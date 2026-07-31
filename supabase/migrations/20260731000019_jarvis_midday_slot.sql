-- Midday pace check: a fourth Jarvis slot at 14:30 IST (09:00 UTC).
--
-- Why. The engine had three slots - close-out 00:05, morning brief 07:00,
-- evening nudge 20:30 - and only two of them notify (the close-out lands inside
-- quiet hours). Two pushes a day is what "notifications are very less" means.
--
-- More to the point, the evening nudge arrives after the day is already decided.
-- The owner averages ~87g of protein against a 151-162g target; at 20:30 there
-- is one meal left in which to find 75g. 14:30 is late enough to know how the
-- day is going and early enough to still change it.
--
-- The slot is SILENT on a day that is on track: runMidday returns without
-- writing a briefing or pushing anything when jbMiddayBody has nothing concrete
-- to say. A notification that fires daily regardless of content is one the user
-- learns to swipe away, which costs the other three their credibility too.

do $jcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'jarvis_midday'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$jcron$;

select cron.schedule('jarvis_midday', '0 9 * * *', $$select public.jarvis_ping('midday')$$);
