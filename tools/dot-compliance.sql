-- DOT Compliance: daily snapshots of the FMCSA record, owner + people the owner allows. Safe to re-run.
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
  using (has_right('dot'))
  with check (has_right('dot'));

revoke all on public.dot_snapshots from anon;
grant select, insert, update on public.dot_snapshots to authenticated;  -- row rule above limits this to the owner and allowed people; no delete

-- DOT reminders: "I filed my MCS-150" / "I paid UCR" check-offs, owner + people the owner allows. Safe to re-run.
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
  using (has_right('dot'))
  with check (has_right('dot'));
revoke all on public.dot_reminders from anon;
grant select, insert, update on public.dot_reminders to authenticated;  -- row rule above limits this to the owner and allowed people; no delete

-- Let the Team page grant the "See DOT Compliance" right (adds the word 'dot' to the allowed rights). Safe to re-run.
do $$
declare cname text; def text; fdef text;
begin
  select conname, pg_get_constraintdef(oid) into cname, def
  from pg_constraint
  where conrelid = 'public.staff_rights'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%permission%'
  limit 1;
  if cname is not null and def not like '%''dot''%' then
    execute format('alter table public.staff_rights drop constraint %I', cname);
    execute format('alter table public.staff_rights add constraint %I %s', cname,
                   replace(def, 'ARRAY[', 'ARRAY[''dot''::text, '));
  end if;

  select pg_get_functiondef(p.oid) into fdef
  from pg_proc p where p.proname = 'set_right' and p.pronamespace = 'public'::regnamespace;
  if fdef is not null and fdef not like '%''dot''%' then
    if position($q$('delete','activity','extra_work','equipment')$q$ in fdef) > 0 then
      execute replace(fdef, $q$('delete','activity','extra_work','equipment')$q$, $q$('delete','activity','extra_work','equipment','dot')$q$);
    else
      raise exception 'set_right looks different than expected - nothing was changed';
    end if;
  end if;
end $$;
