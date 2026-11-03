-- DOT Compliance: daily snapshots of the FMCSA record, admins only. Safe to re-run.
create table if not exists public.dot_snapshots (
  id uuid primary key default gen_random_uuid(),
  snap_date date not null unique default ((now() at time zone 'America/Chicago')::date),
  dot_number text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

alter table public.dot_snapshots enable row level security;

drop policy if exists dot_snapshots_admin on public.dot_snapshots;
create policy dot_snapshots_admin on public.dot_snapshots
  for all to authenticated
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');

revoke all on public.dot_snapshots from anon;
grant select, insert, update on public.dot_snapshots to authenticated;  -- row rule above limits this to admins; no delete
