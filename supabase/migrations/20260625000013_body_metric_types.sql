-- Fix a latent bug: the UI + edge fn already write body_fat_pct / waist_cm body
-- metrics, but the original CHECK rejected them, so those writes were failing.
-- Widen the allowed metric_type set. Mirrored into schema.sql.

alter table public.body_metrics drop constraint if exists body_metrics_metric_type_check;
alter table public.body_metrics add constraint body_metrics_metric_type_check
  check (metric_type in ('weight','sleep_hours','steps','water_ml','body_fat_pct','waist_cm'));
