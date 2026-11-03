-- Customer tracking portal. Run ONCE in the Supabase SQL editor. Safe to re-run. Changes nothing for staff or drivers.
-- A customer login sees ONLY that customer's loads that are not yet delivered. Delivered/cancelled/failed loads vanish at once.
-- Live truck position is shown only while a load is in transit. No driver name, phone or pay is ever returned.
-- Only loads dated within the last 48 hours are shown, so old loads that were never marked delivered don't pile up.
-- If a customer has no active load, the portal shows "No active shipments" and returns nothing (access auto-closes; it re-opens when a new load is posted).

-- 1) Which login belongs to which customer. Nobody can read this table directly (no policies); only the functions below touch it.
create table if not exists public.customer_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  match_names text[] not null default '{}',        -- extra spellings of the customer's name used on loads
  window_hours int not null default 48,            -- only loads dated within this many hours are shown (old, never-closed loads stay hidden)
  is_enabled boolean not null default true,        -- owner kill-switch
  created_at timestamptz not null default now()
);
alter table public.customer_users add column if not exists window_hours int not null default 48;
alter table public.customer_users enable row level security;
revoke all on public.customer_users from anon, authenticated;

create or replace function public.is_customer_user()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.customer_users where user_id = auth.uid()) $$;
revoke all on function public.is_customer_user() from public, anon;
grant execute on function public.is_customer_user() to authenticated;

-- 2) Close a gap found while building this: any logged-in user could read every truck (incl. live GPS) and vehicle document.
--    Customer logins are now blocked from both. Everyone else keeps exactly the access they had.
drop policy if exists "vehicles select all" on public.vehicles;
create policy "vehicles select all" on public.vehicles for select to authenticated
  using (not public.is_customer_user());
drop policy if exists "vehicle_documents select all" on public.vehicle_documents;
create policy "vehicle_documents select all" on public.vehicle_documents for select to authenticated
  using (not public.is_customer_user());

-- 3) What the customer page calls.
create or replace function public.customer_portal()
returns jsonb language plpgsql stable security definer set search_path = public as
$$
declare
  cu record; names text[]; loads jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('access','none'); end if;
  select u.match_names, u.window_hours, c.name as company into cu
  from public.customer_users u join public.customers c on c.id = u.customer_id
  where u.user_id = auth.uid() and u.is_enabled;
  if not found then return jsonb_build_object('access','none'); end if;
  -- a staff or driver account can never use this
  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','dispatcher'))
     or exists (select 1 from public.drivers d where d.profile_id = auth.uid()) then
    return jsonb_build_object('access','none');
  end if;
  names := array(select lower(btrim(x)) from unnest(array[cu.company] || cu.match_names) x);

  select coalesce(jsonb_agg(l.j order by l.sched nulls last, l.jn), '[]'::jsonb) into loads
  from (
    select j.job_number as jn, coalesce(j.scheduled_time, j.created_at) as sched,
      jsonb_build_object(
        'job_number', j.job_number,
        'status', j.status,
        'pickup_address', j.pickup_address,
        'drop_address', j.drop_address,
        'scheduled_time', j.scheduled_time,
        'scheduled_delivery_time', j.scheduled_delivery_time,
        'picked_up_at', j.picked_up_at,
        'drop_lat', j.drop_lat, 'drop_lng', j.drop_lng,
        'pickup_lat', j.pickup_lat, 'pickup_lng', j.pickup_lng,
        'location', case when j.status = 'in_transit' then
            (select case
               when v.motive_lat is not null and v.motive_located_at > now() - interval '2 hours'
                 then jsonb_build_object('lat', v.motive_lat, 'lng', v.motive_lng, 'at', v.motive_located_at)
               when d.current_lat is not null and d.last_ping > now() - interval '2 hours'
                 then jsonb_build_object('lat', d.current_lat, 'lng', d.current_lng, 'at', d.last_ping)
               else null end
             from (select 1) x
             left join public.vehicles v on v.id = j.assigned_vehicle
             left join public.drivers d on d.id = j.assigned_driver)
          else null end
      ) as j
    from public.jobs j
    where lower(btrim(j.customer_name)) = any (names)
      and coalesce(j.status,'') not in ('delivered','cancelled','failed')
      and coalesce(j.scheduled_time, j.created_at) > now() - make_interval(hours => cu.window_hours)
      and j.delivered_at is null and j.failed_at is null
  ) l;

  if jsonb_array_length(loads) = 0 then
    return jsonb_build_object('access','closed','company', cu.company);
  end if;
  return jsonb_build_object('access','open','company', cu.company,'loads', loads);
end;
$$;
revoke all on function public.customer_portal() from public, anon;
grant execute on function public.customer_portal() to authenticated;

-- 4) Owner tools (run from this SQL editor, or by the signed-in owner). Nobody else can use them.
create or replace function public._cp_owner_ok() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(public.is_super_admin(), false) or session_user in ('postgres','supabase_admin') $$;
revoke all on function public._cp_owner_ok() from public, anon, authenticated;

-- Link a login (create the user first in Authentication > Users) to a customer:
--   select admin_link_customer('buyer@theircompany.com', (select id from customers where name = 'THEIR NAME'));
create or replace function public.admin_link_customer(p_email text, p_customer_id uuid, p_extra_names text[] default '{}')
returns text language plpgsql security definer set search_path = public as
$$
declare uid uuid;
begin
  if not public._cp_owner_ok() then raise exception 'not allowed'; end if;
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then raise exception 'No login with that email. Create it first in Authentication > Users.'; end if;
  if exists (select 1 from public.profiles p where p.id = uid and p.role in ('admin','dispatcher'))
     or exists (select 1 from public.drivers d where d.profile_id = uid) then
    raise exception 'That login belongs to staff or a driver. Use a separate login for the customer.';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then raise exception 'Unknown customer.'; end if;
  insert into public.customer_users (user_id, customer_id, match_names, is_enabled)
  values (uid, p_customer_id, coalesce(p_extra_names,'{}'), true)
  on conflict (user_id) do update set customer_id = excluded.customer_id, match_names = excluded.match_names, is_enabled = true;
  return 'linked';
end;
$$;
revoke all on function public.admin_link_customer(text, uuid, text[]) from public, anon;
grant execute on function public.admin_link_customer(text, uuid, text[]) to authenticated;

-- Switch a customer login off / on:  select admin_set_customer_access('buyer@theircompany.com', false);
create or replace function public.admin_set_customer_access(p_email text, p_enabled boolean)
returns text language plpgsql security definer set search_path = public as
$$
begin
  if not public._cp_owner_ok() then raise exception 'not allowed'; end if;
  update public.customer_users set is_enabled = p_enabled
   where user_id = (select id from auth.users where lower(email) = lower(btrim(p_email)));
  if not found then raise exception 'No customer login with that email.'; end if;
  return case when p_enabled then 'on' else 'off' end;
end;
$$;
revoke all on function public.admin_set_customer_access(text, boolean) from public, anon;
grant execute on function public.admin_set_customer_access(text, boolean) to authenticated;

-- See who is linked:  select * from admin_list_customer_users();
create or replace function public.admin_list_customer_users()
returns table (email text, company text, enabled boolean, extra_names text[])
language plpgsql security definer set search_path = public as
$$
begin
  if not public._cp_owner_ok() then raise exception 'not allowed'; end if;
  return query select u.email::text, c.name, cu.is_enabled, cu.match_names
    from public.customer_users cu join auth.users u on u.id = cu.user_id join public.customers c on c.id = cu.customer_id
    order by c.name;
end;
$$;
revoke all on function public.admin_list_customer_users() from public, anon;
grant execute on function public.admin_list_customer_users() to authenticated;
