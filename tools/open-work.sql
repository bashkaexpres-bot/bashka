-- Open Work: portal posts jobs, drivers accept in the driver app (no pay shown to drivers).
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.open_work (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  work_date date not null,
  start_time time not null,
  end_time time not null,
  pickup_address text,
  drop_address text,
  pay numeric,                         -- staff only, never sent to drivers
  slots int not null default 1 check (slots >= 1),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.open_work_claims (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.open_work(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  status text not null default 'accepted' check (status in ('accepted','cancelled')),
  claimed_at timestamptz not null default now(),
  unique (work_id, driver_id)
);

alter table public.open_work enable row level security;
alter table public.open_work_claims enable row level security;

drop policy if exists open_work_staff on public.open_work;
create policy open_work_staff on public.open_work
  for all to authenticated
  using (get_my_role() = any (array['admin','dispatcher']))
  with check (get_my_role() = any (array['admin','dispatcher']));

drop policy if exists open_work_claims_staff on public.open_work_claims;
create policy open_work_claims_staff on public.open_work_claims
  for all to authenticated
  using (get_my_role() = any (array['admin','dispatcher']))
  with check (get_my_role() = any (array['admin','dispatcher']));

revoke all on public.open_work, public.open_work_claims from anon;
grant select, insert, update, delete on public.open_work, public.open_work_claims to authenticated;  -- row rules above limit this to staff

-- Internal helper: returns NULL if the driver is free, otherwise the reason he is blocked.
create or replace function public.open_work_conflict(p_driver uuid, p_date date, p_start time, p_end time, p_exclude uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  js numeric := extract(epoch from p_start) / 60;
  je numeric := extract(epoch from p_end) / 60;
  rs numeric; re numeric;
  w record;
  ws numeric; we numeric;
begin
  if je <= js then je := je + 1440; end if;

  -- 1) the driver's route that day (default or override)
  for r in
    select a.route_id, a.route_name, p.pickup_time, p.delivery_time
    from public.admin_get_week_route_assignments(p_date) a
    left join public.payroll_routes p on p.id = a.route_id
    where a.driver_id = p_driver and a.assignment_date = p_date and a.route_id is not null
  loop
    if r.pickup_time is null or r.delivery_time is null then
      return 'Your route today (' || coalesce(r.route_name, 'route') || ') has no set times - ask dispatch';
    end if;
    rs := extract(epoch from r.pickup_time) / 60;
    re := extract(epoch from r.delivery_time) / 60;
    if re <= rs then re := re + 1440; end if;
    if js < re and je > rs then
      return 'Conflicts with your route ' || coalesce(r.route_name, '') || ' (' || to_char(r.pickup_time, 'HH12:MI AM') || ' - ' || to_char(r.delivery_time, 'HH12:MI AM') || ')';
    end if;
  end loop;

  -- 2) other open work he already accepted that day
  for w in
    select o.title, o.start_time, o.end_time
    from public.open_work_claims c
    join public.open_work o on o.id = c.work_id
    where c.driver_id = p_driver and c.status = 'accepted' and o.work_date = p_date
      and o.status <> 'cancelled' and (p_exclude is null or o.id <> p_exclude)
  loop
    ws := extract(epoch from w.start_time) / 60;
    we := extract(epoch from w.end_time) / 60;
    if we <= ws then we := we + 1440; end if;
    if js < we and je > ws then
      return 'Conflicts with other work you accepted: ' || w.title;
    end if;
  end loop;

  return null;
end $$;

-- Driver: list open work (NO pay column).
create or replace function public.driver_list_open_work()
returns table (
  id uuid, title text, description text, work_date date, start_time time, end_time time,
  pickup_address text, drop_address text, slots int, taken int,
  accepted boolean, blocked_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare me uuid;
begin
  select d.id into me from public.drivers d where d.profile_id = auth.uid() and d.status = 'active' limit 1;
  if me is null then return; end if;
  return query
  select o.id, o.title, o.description, o.work_date, o.start_time, o.end_time,
         o.pickup_address, o.drop_address, o.slots,
         (select count(*)::int from public.open_work_claims c where c.work_id = o.id and c.status = 'accepted'),
         exists (select 1 from public.open_work_claims c where c.work_id = o.id and c.driver_id = me and c.status = 'accepted'),
         case
           when exists (select 1 from public.open_work_claims c where c.work_id = o.id and c.driver_id = me and c.status = 'accepted') then null
           when (select count(*) from public.open_work_claims c where c.work_id = o.id and c.status = 'accepted') >= o.slots then 'Already taken'
           else public.open_work_conflict(me, o.work_date, o.start_time, o.end_time, o.id)
         end
  from public.open_work o
  where (o.status = 'open'
         or (o.status = 'closed' and exists (select 1 from public.open_work_claims c where c.work_id = o.id and c.driver_id = me and c.status = 'accepted')))
    and o.work_date >= (now() at time zone 'America/Chicago')::date
  order by o.work_date, o.start_time;
end $$;

-- Driver: accept a job (checks everything again on the server).
create or replace function public.driver_accept_open_work(p_work_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare me uuid; o public.open_work; why text;
begin
  select d.id into me from public.drivers d where d.profile_id = auth.uid() and d.status = 'active' limit 1;
  if me is null then raise exception 'Driver account not found'; end if;
  select * into o from public.open_work where id = p_work_id for update;
  if not found or o.status <> 'open' then raise exception 'This job is no longer open'; end if;
  if o.work_date < (now() at time zone 'America/Chicago')::date then raise exception 'This job date has passed'; end if;
  if exists (select 1 from public.open_work_claims where work_id = o.id and driver_id = me and status = 'accepted') then
    return 'already accepted';
  end if;
  if (select count(*) from public.open_work_claims where work_id = o.id and status = 'accepted') >= o.slots then
    raise exception 'Already taken';
  end if;
  why := public.open_work_conflict(me, o.work_date, o.start_time, o.end_time, o.id);
  if why is not null then raise exception '%', why; end if;
  insert into public.open_work_claims (work_id, driver_id, status) values (o.id, me, 'accepted')
    on conflict (work_id, driver_id) do update set status = 'accepted', claimed_at = now();
  if (select count(*) from public.open_work_claims where work_id = o.id and status = 'accepted') >= o.slots then
    update public.open_work set status = 'closed' where id = o.id;
  end if;
  return 'accepted';
end $$;

-- Driver: cancel his own acceptance (only before the job date has passed).
create or replace function public.driver_cancel_open_work(p_work_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare me uuid;
begin
  select d.id into me from public.drivers d where d.profile_id = auth.uid() and d.status = 'active' limit 1;
  if me is null then raise exception 'Driver account not found'; end if;
  update public.open_work_claims c set status = 'cancelled'
   where c.work_id = p_work_id and c.driver_id = me and c.status = 'accepted'
     and exists (select 1 from public.open_work o where o.id = c.work_id and o.work_date >= (now() at time zone 'America/Chicago')::date);
  update public.open_work set status = 'open'
   where id = p_work_id and status = 'closed'
     and (select count(*) from public.open_work_claims where work_id = p_work_id and status = 'accepted') < slots;
  return 'cancelled';
end $$;

-- Lock down: only signed-in users can call the driver functions; helper is internal only.
revoke all on function public.open_work_conflict(uuid, date, time, time, uuid) from public, anon, authenticated;
revoke all on function public.driver_list_open_work() from public, anon;
revoke all on function public.driver_accept_open_work(uuid) from public, anon;
revoke all on function public.driver_cancel_open_work(uuid) from public, anon;
grant execute on function public.driver_list_open_work() to authenticated;
grant execute on function public.driver_accept_open_work(uuid) to authenticated;
grant execute on function public.driver_cancel_open_work(uuid) to authenticated;
