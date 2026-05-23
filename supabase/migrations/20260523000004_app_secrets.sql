-- App-level secrets that the edge function reads at boot.
-- service_role only; anon and authenticated cannot see this table.

create table if not exists public.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_secrets enable row level security;

-- No policies → service_role bypasses RLS, everyone else gets nothing.

create or replace function public.touch_app_secrets() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_app_secrets on public.app_secrets;
create trigger trg_touch_app_secrets
  before update on public.app_secrets
  for each row execute function public.touch_app_secrets();
