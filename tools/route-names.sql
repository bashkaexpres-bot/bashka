-- Route place names: a name for each route's pickup and delivery place (e.g. "ABC Shakopee", "Capital warehouse").
-- Run ONCE in the Supabase SQL editor, AFTER daily-reports.sql. Safe to re-run. Changes nothing for existing features.
-- Names live on the route, so every load made from that route shows them in the Daily Report.

create table if not exists public.route_place_names (
  route_id uuid primary key references public.payroll_routes(id) on delete cascade,
  pickup_name text,
  drop_name text
);
alter table public.route_place_names enable row level security;
revoke all on public.route_place_names from anon, authenticated;   -- no direct access; only the functions below

-- Admin-only: read all names (for the Route form)
create or replace function public.admin_list_route_place_names()
returns table (route_id uuid, pickup_name text, drop_name text)
language plpgsql stable security definer set search_path = public as
$$
begin
  if coalesce(public.get_my_role(), '') <> 'admin' and not public.is_super_admin() then raise exception 'not allowed'; end if;
  return query select r.route_id, r.pickup_name, r.drop_name from public.route_place_names r;
end;
$$;

-- Admin-only: set the names for one route (blank = remove)
create or replace function public.admin_set_route_place_names(p_route uuid, p_pickup text, p_drop text)
returns void
language plpgsql security definer set search_path = public as
$$
begin
  if coalesce(public.get_my_role(), '') <> 'admin' and not public.is_super_admin() then raise exception 'not allowed'; end if;
  if nullif(btrim(coalesce(p_pickup,'')), '') is null and nullif(btrim(coalesce(p_drop,'')), '') is null then
    delete from public.route_place_names where route_id = p_route;
  else
    insert into public.route_place_names(route_id, pickup_name, drop_name)
    values (p_route, nullif(btrim(p_pickup), ''), nullif(btrim(p_drop), ''))
    on conflict (route_id) do update set pickup_name = excluded.pickup_name, drop_name = excluded.drop_name;
  end if;
end;
$$;
revoke all on function public.admin_list_route_place_names() from public, anon;
revoke all on function public.admin_set_route_place_names(uuid, text, text) from public, anon;
grant execute on function public.admin_list_route_place_names() to authenticated;
grant execute on function public.admin_set_route_place_names(uuid, text, text) to authenticated;

-- Daily report: now also returns the pickup and delivery place names
drop function if exists public.report_loads(date, text);
create or replace function public.report_loads(p_day date, p_customer text default null)
returns table (
  job_number text, customer text, pickup_name text, pickup_address text, drop_name text, drop_address text,
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
    select j.job_number, j.customer_name, n.pickup_name, j.pickup_address, n.drop_name, j.drop_address,
           j.scheduled_time, j.scheduled_delivery_time, j.picked_up_at, j.delivered_at,
           j.status, d.full_name, v.unit_number
    from public.jobs j
    left join public.drivers d on d.id = j.assigned_driver
    left join public.vehicles v on v.id = j.assigned_vehicle
    left join public.route_place_names n on n.route_id = j.route_id
    where ((coalesce(j.scheduled_time, j.created_at) at time zone 'America/Chicago')::date) = p_day
      and (p_customer is null or lower(btrim(j.customer_name)) = lower(btrim(p_customer)))
    order by j.scheduled_time nulls last, j.customer_name, j.job_number;
end;
$$;
revoke all on function public.report_loads(date, text) from public, anon;
grant execute on function public.report_loads(date, text) to authenticated, service_role;
