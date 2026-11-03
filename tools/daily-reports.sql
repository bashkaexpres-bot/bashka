-- Daily Reports: one spreadsheet per day with every load's pickup and delivery times.
-- Run ONCE in the Supabase SQL editor. Safe to re-run. Changes nothing for existing features.
-- Who can see it: the owner, plus admins the owner allows on the Team page ("See Daily Reports").

-- 1) Let the Team page grant the new "reports" right (adds the word 'reports' to the allowed rights).
do $$
declare cname text; def text; fdef text;
begin
  select conname, pg_get_constraintdef(oid) into cname, def
  from pg_constraint
  where conrelid = 'public.staff_rights'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%permission%'
  limit 1;
  if cname is not null and def not like '%''reports''%' then
    execute format('alter table public.staff_rights drop constraint %I', cname);
    execute format('alter table public.staff_rights add constraint %I %s', cname,
                   replace(def, 'ARRAY[', 'ARRAY[''reports''::text, '));
  end if;

  select pg_get_functiondef(p.oid) into fdef
  from pg_proc p where p.proname = 'set_right' and p.pronamespace = 'public'::regnamespace;
  if fdef is not null and fdef not like '%''reports''%' then
    if position($q$('delete','activity','extra_work','equipment','dot')$q$ in fdef) > 0 then
      execute replace(fdef, $q$('delete','activity','extra_work','equipment','dot')$q$, $q$('delete','activity','extra_work','equipment','dot','reports')$q$);
    else
      raise exception 'set_right looks different than expected - nothing was changed';
    end if;
  end if;
end $$;

-- 2) A list of the saved nightly reports. Readable only with the right; written only by the server job.
create table if not exists public.daily_reports (
  day date primary key,
  row_count int not null default 0,
  file_path text not null,
  created_at timestamptz not null default now()
);
alter table public.daily_reports enable row level security;
revoke all on public.daily_reports from anon, authenticated;
grant select on public.daily_reports to authenticated;
drop policy if exists daily_reports_read on public.daily_reports;
create policy daily_reports_read on public.daily_reports for select to authenticated using (public.has_right('reports'));

-- 3) Private storage for the files. No storage policies = nobody can read them directly; only the server job and the download endpoint.
insert into storage.buckets (id, name, public) values ('daily-reports', 'daily-reports', false) on conflict (id) do nothing;

-- 4) The load list for one Central-time day (by scheduled date). Allowed only for the server job or someone with the right.
create or replace function public.report_loads(p_day date)
returns table (
  job_number text, customer text, pickup_address text, drop_address text,
  scheduled_pickup timestamptz, scheduled_delivery timestamptz,
  actual_pickup timestamptz, actual_delivery timestamptz,
  status text, driver text, truck text
)
language plpgsql stable security definer set search_path = public as
$$
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.has_right('reports')) then
    raise exception 'not allowed';
  end if;
  return query
    select j.job_number, j.customer_name, j.pickup_address, j.drop_address,
           j.scheduled_time, j.scheduled_delivery_time, j.picked_up_at, j.delivered_at,
           j.status, d.full_name, v.unit_number
    from public.jobs j
    left join public.drivers d on d.id = j.assigned_driver
    left join public.vehicles v on v.id = j.assigned_vehicle
    where ((coalesce(j.scheduled_time, j.created_at) at time zone 'America/Chicago')::date) = p_day
    order by j.scheduled_time nulls last, j.customer_name, j.job_number;
end;
$$;
revoke all on function public.report_loads(date) from public, anon;
grant execute on function public.report_loads(date) to authenticated, service_role;
