-- Capture idempotency: a stable fingerprint per capture so a re-submit or a
-- retried edge-function invoke resolves to the run that already happened instead
-- of writing the ledger a second and third time.
--
-- The defect this closes (2026-07-09): "Just ate 20 rupees lays and 60 for 3
-- boiled eggs and some riata" produced ledger rows THREE times — 80, then 20+60,
-- then 20+60 — after a transport error convinced the client nothing had landed
-- and the user re-submitted. ~Rs 240 recorded for an Rs 80 purchase.
--
-- Deliberately NOT a unique constraint on (user_id, amount, direction, minute,
-- description):
--   * it would permanently forbid genuinely repeated identical purchases (the
--     same Rs 20 chai twice in an afternoon is real data, not a duplicate), and
--   * when it fired, the constraint violation would be caught by the edge
--     function's applyTool try/catch and buried in an ai_actions row with
--     status='errored' — silent data loss, the exact failure mode this codebase
--     exists to prevent.
-- The guard is instead a LOOKUP in the edge function over a short window: a
-- repeat inside 10 minutes is folded into the first run, and the identical
-- purchase made an hour later writes normally.
--
-- The fingerprint is computed SERVER-SIDE (see captureFingerprint() in
-- supabase/functions/agent/index.ts) from (user_id, normalised raw text, media
-- asset ids) and never from wall-clock time — the two submits above were 60
-- seconds apart, so any minute bucket sees two different captures.
--
-- Idempotent. Schema-only: touches no existing rows. Repairing the Rs 240 of
-- already-duplicated ledger rows is a separate, explicit step.

alter table public.raw_ingestions
  add column if not exists capture_fingerprint text;

-- Set when a capture was recognised as a repeat: this ingestion never ran a
-- pipeline of its own, and points at the ingestion whose run it reused. Null
-- means "not a duplicate" — never confuse it with "duplicate of nothing".
alter table public.raw_ingestions
  add column if not exists duplicate_of_ingestion_id uuid
    references public.raw_ingestions(id) on delete set null;

-- Serves the guard's lookup: same user + same fingerprint + inside the window.
create index if not exists ix_raw_ingestions_fingerprint
  on public.raw_ingestions(user_id, capture_fingerprint, created_at desc)
  where capture_fingerprint is not null;

-- Serves both the server-side "has this capture already completed a run?" check
-- and the client's post-transport-error poll for a run on one ingestion.
create index if not exists ix_ai_runs_ingestion_status
  on public.ai_runs(ingestion_id, status, created_at desc);
