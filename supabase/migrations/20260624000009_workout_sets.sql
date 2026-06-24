-- Detailed gym tracker, minimal-schema: per-exercise sets live as JSONB on the
-- existing workout_logs row (no new tables). Body composition reuses body_metrics.
alter table public.workout_logs
  add column if not exists sets jsonb not null default '[]'::jsonb,
  add column if not exists bodyweight_kg numeric,
  add column if not exists notes text;
