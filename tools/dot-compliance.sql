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

-- DOT reminders: "I filed my MCS-150" / "I paid UCR" check-offs, admins only. Safe to re-run.
create table if not exists public.dot_reminders (
  key text primary key check (key in ('mcs150','ucr')),
  done_for text check (char_length(done_for) <= 10),
  done_on date,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.dot_reminders enable row level security;
drop policy if exists dot_reminders_admin on public.dot_reminders;
create policy dot_reminders_admin on public.dot_reminders
  for all to authenticated
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');
revoke all on public.dot_reminders from anon;
grant select, insert, update on public.dot_reminders to authenticated;  -- row rule above limits this to admins; no delete
