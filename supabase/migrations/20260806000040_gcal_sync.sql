-- GOOGLE CALENDAR SYNC - the tables behind supabase/functions/gcal.
--
-- Asked for out loud: "the calendar must connect to my Gmail/Google Calendar,
-- and in future mirror any other calendar."
--
-- Five ideas carry the whole design, and every one of them is here because the
-- naive version of it has a documented failure mode:
--
-- 1. WE WRITE TO A CALENDAR OF OUR OWN, NEVER TO THEIRS. The OAuth grant uses
--    `calendar.app.created`, which can only ever touch the calendar this app
--    made. A bug in push therefore cannot overwrite a real dentist appointment;
--    the worst case is a mess inside a calendar the user can delete in one tap.
--    `calendar_accounts.calendar_id` is that calendar. Everything we PULL from
--    the user's other calendars lands in `calendar_events_raw`, which nothing
--    writes back.
--
-- 2. A REMOTE DELETE IS ONLY EVER AN EXPLICIT TOMBSTONE. Google's incremental
--    sync returns `status = "cancelled"` for a deleted event; that, and only
--    that, sets `calendar_events_raw.tombstoned_at`. Inferring a delete from
--    "the event was not in this page of results" is how a partial sync, a
--    dropped syncToken or a 410 wipes a year of someone's calendar. There is no
--    code path in this feature that deletes from absence.
--
-- 3. THREE LOOP GUARDS, ALL OF THEM, ON DAY ONE. `local_hash` + `remote_hash`
--    (content gate), `etag` (version echo) and the X-TRACKERZ-ORIGIN extended
--    property (authorship) are all stored per link, because each one fails
--    alone: Google normalises our payload so the hash changes on a round trip
--    we caused, and origin alone says "ours" even after the user genuinely
--    edited the event by hand. lib/gcal-sync.mjs is the decision logic and
--    tests/gcal-sync.test.mjs runs 100 pull->push->pull iterations that must
--    converge to a noop with exactly one write.
--
-- 4. REFRESH TOKENS ARE NOT USER DATA. `calendar_secrets` follows the
--    `app_secrets` posture exactly - RLS enabled, NO policies - so it is
--    invisible to anon and authenticated and readable only by the service role
--    inside the edge function. A refresh token in a browser-readable table is a
--    permanent grant on someone's calendar sitting behind a JWT.
--
-- 5. A BROKEN SYNC MUST BE LOUD. `sync_broken_since` + `sync_broken_reason`
--    exist because the failure mode of this integration is not an error page,
--    it is an EMPTY CALENDAR that looks fine. Google's OAuth "Testing" mode
--    revokes every refresh token after 7 days (see docs/GOOGLE-CALENDAR-SETUP.md),
--    and the app would silently show no events with a missed deadline as the
--    payload. The UI renders a banner off these two columns.
--
-- Idempotent.

-- ===========================================================================
-- 1. calendar_accounts - one connected calendar provider account
-- ===========================================================================
-- `provider` is open-ended by design: the ask is Google first and "any other
-- calendar" later, and a provider column added on the day the second one lands
-- means a migration against live rows. Microsoft Graph and CalDAV both have the
-- same shape (an account, a calendar, a delta/sync token, a subscription that
-- expires), so the columns below already fit them.
create table if not exists public.calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'google'
    check (provider in ('google', 'microsoft', 'caldav', 'ics')),
  -- Which Google account this is. Shown in Settings so "connected" can never be
  -- a claim about an account the user cannot name.
  external_account_email text,

  -- THE CALENDAR WE OWN. Created through calendar.app.created, so our writes
  -- are physically incapable of reaching the user's real calendars.
  calendar_id text,
  calendar_summary text,

  -- Incremental sync cursor. Dropped and re-fetched on a 410 GONE, which is
  -- normal control flow rather than an error (Google expires sync tokens).
  sync_token text,
  sync_token_updated_at timestamptz,
  -- The last full resync, so "we have never completed one" is answerable.
  last_full_sync_at timestamptz,

  -- The READ-ONLY half, tracked separately. The mirror walks a different
  -- calendar with a different cursor, and sharing one sync_token between them
  -- would make a 410 on either side silently discard the other's position.
  -- 'primary' is the user's own main Google calendar; a future "mirror any other
  -- calendar" only has to change this value.
  mirror_calendar_id text not null default 'primary',
  mirror_sync_token text,

  -- events.watch push channel. Google expires these at ~30 days and does NOT
  -- renew them; `renew` re-registers anything inside the window. A channel that
  -- silently lapsed is a calendar that quietly stopped updating.
  channel_id text,
  channel_resource_id text,
  channel_expiry timestamptz,

  scopes text[] not null default '{}'::text[],
  status text not null default 'connected'
    check (status in ('connected', 'disconnected', 'needs_reauth')),

  -- Honesty columns. last_sync_at is the last SUCCESSFUL sync, never the last
  -- attempt: an attempt timestamp that moves on failure is how a dead
  -- integration renders as a healthy one.
  last_sync_at timestamptz,
  last_push_at timestamptz,
  sync_broken_since timestamptz,
  sync_broken_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_accounts_identity unique (user_id, provider, external_account_email)
);
-- `create table if not exists` adds no columns to a table that already exists, so
-- every column introduced after the first apply also needs an explicit alter.
-- Without these the migration is idempotent in name only: it re-runs cleanly and
-- leaves the database a version behind, which is the exact failure that took this
-- app down once already.
alter table public.calendar_accounts add column if not exists mirror_calendar_id text not null default 'primary';
alter table public.calendar_accounts add column if not exists mirror_sync_token text;

create index if not exists ix_calendar_accounts_user on public.calendar_accounts(user_id, provider);
create index if not exists ix_calendar_accounts_channel on public.calendar_accounts(channel_id) where channel_id is not null;
create index if not exists ix_calendar_accounts_renew on public.calendar_accounts(channel_expiry) where status = 'connected';

comment on column public.calendar_accounts.last_sync_at is
  'Last SUCCESSFUL sync. Never touched on failure - an attempt timestamp that moves when the sync failed makes a dead integration look healthy.';
comment on column public.calendar_accounts.sync_broken_since is
  'Set the moment a sync fails for a reason retrying will not fix (revoked/expired refresh token, 401, 403). Cleared only by a successful sync. The Settings banner reads this column.';

-- ===========================================================================
-- 2. calendar_links - our reminder <-> their event, and the three loop guards
-- ===========================================================================
-- One row per (account, remote event) that we know about as OURS. The three
-- hash/etag/origin columns are the entire anti-echo mechanism:
--
--   local_hash  - hash of the reminder as we last SENT it. Differs from the
--                 reminder's current hash => we have a local edit to push.
--   remote_hash - hash of the event as it last came BACK. Differs from what we
--                 just pulled => there is a genuine remote edit to apply.
--   etag        - Google's version of the event as we last saw it. An identical
--                 etag means nothing changed, whatever the hashes say about
--                 fields Google normalised.
--
-- `origin` records who created the row. 'local' = we pushed a reminder out;
-- 'remote' = the user made it in Google and we adopted it. It decides who wins
-- a genuine conflict, and it is deliberately NOT the loop guard on its own -
-- an event we created that the user then edited is still origin='local'.
create table if not exists public.calendar_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.calendar_accounts(id) on delete cascade,
  reminder_id uuid references public.reminders(id) on delete cascade,

  event_id text not null,
  -- Which calendar the event lives on. Ours for pushed rows; possibly a
  -- different one for an adopted row.
  calendar_id text,
  etag text,
  local_hash text,
  remote_hash text,
  origin text not null default 'local' check (origin in ('local', 'remote')),

  -- A push we know Google accepted, and a pull we know we applied. Two columns
  -- rather than one so "we sent it and never saw it come back" is visible.
  last_pushed_at timestamptz,
  last_pulled_at timestamptz,
  -- Set when the REMOTE side is gone (explicit cancellation). The link is kept
  -- so a later re-appearance of the same event id is recognised rather than
  -- duplicated.
  remote_deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_links_event_once unique (account_id, event_id)
);
-- A reminder maps to at most one event per account. Without this a retried push
-- that lost its response creates a second event every time it retries.
create unique index if not exists ux_calendar_links_reminder
  on public.calendar_links(account_id, reminder_id) where reminder_id is not null;
create index if not exists ix_calendar_links_user on public.calendar_links(user_id, updated_at desc);

-- ===========================================================================
-- 3. calendar_events_raw - the READ-ONLY mirror of everything we do not own
-- ===========================================================================
-- Third-party appointments: other people's names, other people's business. This
-- table is written only by the pull path and read only for display and for the
-- agent's context. Nothing in the app writes back to a row here, and the agent
-- treats its text as UNTRUSTED (see supabase/functions/gcal/index.ts and
-- docs/GOOGLE-CALENDAR-SETUP.md).
create table if not exists public.calendar_events_raw (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.calendar_accounts(id) on delete cascade,

  calendar_id text not null,
  event_id text not null,
  etag text,
  -- Google's own status: 'confirmed' | 'tentative' | 'cancelled'.
  status text,

  summary text,
  description text,
  location text,
  organizer_email text,
  -- Names and addresses of OTHER PEOPLE. Stored because a meeting without its
  -- attendees is not the meeting; never sent anywhere.
  attendees jsonb not null default '[]'::jsonb,

  starts_at timestamptz,
  ends_at timestamptz,
  all_day boolean not null default false,
  start_date date,
  recurrence text[],
  recurring_event_id text,
  html_link text,

  -- THE TOMBSTONE. Set ONLY from an explicit remote cancellation, never from
  -- "it was missing from the results". Rows are tombstoned, not deleted, so a
  -- pull that re-delivers the same event id does not resurrect it as new and a
  -- bad sync is auditable after the fact.
  tombstoned_at timestamptz,

  remote_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint calendar_events_raw_once unique (account_id, event_id)
);
create index if not exists ix_calendar_events_raw_window
  on public.calendar_events_raw(user_id, starts_at) where tombstoned_at is null;
create index if not exists ix_calendar_events_raw_account
  on public.calendar_events_raw(account_id, last_seen_at desc);

comment on table public.calendar_events_raw is
  'READ-ONLY mirror of remote calendar events we do not own. Third-party content: capability-restricted when it reaches the agent (may emit no tool calls).';
comment on column public.calendar_events_raw.tombstoned_at is
  'Set ONLY from an explicit remote tombstone (status=cancelled). Never inferred from local absence - that inference is how a partial sync deletes a year of someone calendar.';

-- ===========================================================================
-- 4. calendar_secrets - the app_secrets posture, applied to OAuth tokens
-- ===========================================================================
-- RLS ENABLED, NO POLICIES. That combination denies every role that respects
-- RLS (anon, authenticated, and any future role) and leaves only the
-- RLS-bypassing service_role, which exists solely inside the edge function.
-- This is byte-for-byte the posture public.app_secrets has used since
-- 20260523000004; do not "fix" it by adding an owner policy, because the owner
-- is a browser and the browser must never be able to read a refresh token.
create table if not exists public.calendar_secrets (
  account_id uuid primary key references public.calendar_accounts(id) on delete cascade,
  -- The long-lived grant. Issued once, only with access_type=offline AND
  -- prompt=consent; a re-auth without prompt=consent returns NO refresh token
  -- and silently leaves this null.
  refresh_token text,
  -- Cached short-lived token, so a burst of pushes is one token exchange.
  access_token text,
  access_token_expires_at timestamptz,
  -- The shared secret echoed back by Google in X-Goog-Channel-Token. Lives here
  -- rather than on calendar_accounts because it is what authenticates an
  -- unauthenticated public webhook.
  channel_token text,
  updated_at timestamptz not null default now()
);

alter table public.calendar_secrets enable row level security;
-- No policies -> service_role bypasses RLS, everyone else gets nothing.
-- The revokes below are belt and braces: RLS already denies these roles, but a
-- table with no grants cannot be read even if a future migration adds a policy
-- by accident.
revoke all on table public.calendar_secrets from anon, authenticated;

-- One-time-use OAuth `state` values. Same posture: the state ties a Google
-- redirect back to a user, so anyone who can read it can complete someone
-- else's OAuth flow.
create table if not exists public.calendar_oauth_states (
  state text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'google',
  redirect_to text,
  scopes text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  -- Short by design. A state that is valid for a day is a day-long window in
  -- which a leaked link binds an attacker's calendar to this account.
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);
alter table public.calendar_oauth_states enable row level security;
revoke all on table public.calendar_oauth_states from anon, authenticated;
create index if not exists ix_calendar_oauth_states_expiry on public.calendar_oauth_states(expires_at);

-- ===========================================================================
-- 5. calendar_sync_jobs - what the webhook enqueues
-- ===========================================================================
-- Google's webhook carries NO event data and expects a 200 within seconds; it
-- retries with backoff and eventually drops the channel if we are slow. So the
-- receiver verifies the token, writes one row here, and returns. The actual
-- sync happens on the next drain tick.
--
-- The partial unique index collapses a burst: ten edits in ten seconds are ten
-- webhook hits and ONE pending job, because the second insert is a unique
-- violation that the receiver treats as a successful no-op - the same pattern
-- reminder_fires and email_deliveries already use.
create table if not exists public.calendar_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.calendar_accounts(id) on delete cascade,
  reason text not null default 'webhook' check (reason in ('webhook', 'manual', 'cron', 'reconnect')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  resource_state text,
  message_number bigint,
  attempts int not null default 0,
  claimed_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create unique index if not exists ux_calendar_sync_jobs_pending
  on public.calendar_sync_jobs(account_id) where status = 'pending';
create index if not exists ix_calendar_sync_jobs_user on public.calendar_sync_jobs(user_id, created_at desc);

-- Claim pending jobs. `for update skip locked` so the cron drain and a manual
-- "Sync now" arriving together take DIFFERENT rows rather than both taking one.
create or replace function public.claim_calendar_sync_jobs(p_limit int default 10)
returns setof public.calendar_sync_jobs
language plpgsql
security definer
set search_path = public
as $claimcal$
begin
  -- Recover anything a crashed run left running. Without this one crash wedges
  -- an account's sync permanently, which reads exactly like "it stopped working".
  update public.calendar_sync_jobs
     set status = 'pending'
   where status = 'running' and claimed_at is not null and claimed_at < now() - interval '10 minutes';

  return query
  with picked as (
    select id from public.calendar_sync_jobs
     where status = 'pending'
     order by created_at
     for update skip locked
     limit greatest(1, least(p_limit, 50))
  )
  update public.calendar_sync_jobs j
     set status = 'running', claimed_at = now(), attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.*;
end$claimcal$;

revoke all on function public.claim_calendar_sync_jobs(int) from public, anon, authenticated;

-- ===========================================================================
-- 6. RLS on the user-facing tables
-- ===========================================================================
-- calendar_accounts is FULL (the user connects and disconnects it themselves).
-- The other three are SELECT-only from the browser: they are written by the
-- edge function under the service role, and a browser that can UPDATE a
-- sync_token or a tombstone can corrupt the sync in ways no test would catch.
alter table public.calendar_accounts enable row level security;
drop policy if exists "Users manage own rows" on public.calendar_accounts;
create policy "Users manage own rows" on public.calendar_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $calrls$
declare t text;
begin
  for t in select unnest(array['calendar_links', 'calendar_events_raw', 'calendar_sync_jobs'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Users manage own rows" on public.%I', t);
    execute format('drop policy if exists "Users read own rows" on public.%I', t);
    execute format(
      'create policy "Users read own rows" on public.%I for select using (auth.uid() = user_id)', t
    );
  end loop;
end$calrls$;

-- ===========================================================================
-- 7. The scheduler rails
-- ===========================================================================
-- Same shape as jarvis_ping(): read the shared cron secret out of app_secrets
-- and pg_net-POST to the edge function. Two jobs:
--
--   gcal_drain  every 5 minutes - runs whatever the webhook enqueued, plus a
--               safety-net pull for any account whose webhook channel died
--               without telling us. A push channel is an optimisation; polling
--               is the thing that must never stop.
--   gcal_renew  daily - re-registers watch channels inside their expiry window.
--               Google expires them at ~30 days and does not renew them, so a
--               calendar with no renew job goes quiet exactly one month after it
--               starts working, which is the worst possible time to find out.
create or replace function public.gcal_ping(action text)
returns bigint
language plpgsql
security definer
set search_path = public
as $gping$
declare
  secret text;
  req_id bigint;
begin
  select value into secret from public.app_secrets where name = 'JARVIS_CRON_SECRET';
  if secret is null then
    raise warning 'gcal_ping: JARVIS_CRON_SECRET missing from app_secrets - skipping %', action;
    return null;
  end if;
  select net.http_post(
    url := 'https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/gcal',
    body := jsonb_build_object('action', action),
    headers := jsonb_build_object('content-type', 'application/json', 'x-jarvis-secret', secret),
    timeout_milliseconds := 60000
  ) into req_id;
  return req_id;
end$gping$;

revoke all on function public.gcal_ping(text) from public, anon, authenticated;

do $gcron$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('gcal_drain', 'gcal_renew')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$gcron$;

select cron.schedule('gcal_drain', '*/5 * * * *', $gd$select public.gcal_ping('drain')$gd$);
-- 02:20 IST (cron is UTC).
select cron.schedule('gcal_renew', '50 20 * * *', $gr$select public.gcal_ping('renew')$gr$);

-- ===========================================================================
-- 8. PostgREST schema cache
-- ===========================================================================
-- THE TRAP THIS REPO HAS ALREADY PAID FOR ONCE. PostgREST caches the schema; a
-- table or column that exists in Postgres but not in that cache fails EVERY
-- request with PGRST204/PGRST205 and a message that reads like a typo. Reloading
-- it is one line and it belongs at the end of every migration that adds a
-- relation. lib/failure.mjs classifies those codes as "schema" for the same
-- reason.
notify pgrst, 'reload schema';
