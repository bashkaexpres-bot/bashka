-- Phone alerts for Open Work. Safe to re-run. Run AFTER open-work.sql.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- No row rules for drivers or staff = nobody can read these through the app. Only the server (service role) and the two functions below can.
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;

alter table public.open_work add column if not exists push_sent_at timestamptz;

-- the server needs these to alert only drivers who can accept
grant all on public.open_work, public.open_work_claims to service_role;
grant execute on function public.open_work_conflict(uuid, date, time, time, uuid) to service_role;

create or replace function public.driver_save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare me uuid;
begin
  select d.id into me from public.drivers d where d.profile_id = auth.uid() and d.status = 'active' limit 1;
  if me is null then raise exception 'Driver account not found'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 2000 then raise exception 'Bad endpoint'; end if;
  if length(coalesce(p_p256dh,'')) not between 80 and 120 or length(coalesce(p_auth,'')) not between 16 and 40 then raise exception 'Bad keys'; end if;
  insert into public.push_subscriptions (driver_id, endpoint, p256dh, auth, user_agent)
    values (me, p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
    on conflict (endpoint) do update set driver_id = me, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
  -- keep at most 5 phones per driver
  delete from public.push_subscriptions where driver_id = me and id not in (
    select id from public.push_subscriptions where driver_id = me order by created_at desc limit 5);
  return 'saved';
end $$;

create or replace function public.driver_remove_push_subscription(p_endpoint text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare me uuid;
begin
  select d.id into me from public.drivers d where d.profile_id = auth.uid() limit 1;
  if me is null then return 'none'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and driver_id = me;
  return 'removed';
end $$;

revoke all on function public.driver_save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.driver_remove_push_subscription(text) from public, anon;
grant execute on function public.driver_save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.driver_remove_push_subscription(text) to authenticated;
