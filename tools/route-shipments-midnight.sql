-- Route Assignments: auto-create daily route shipments at 12:00 AM Central (was 5:00 AM).
-- Only change vs. the old function: chicago_hour <> 5  ->  chicago_hour <> 0
-- Still weekdays only, once per day, jobs created as 'pending' (no driver assigned, no pay).
CREATE OR REPLACE FUNCTION public.run_daily_route_shipments()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  chicago_now timestamp;
  chicago_hour int;
  chicago_dow int;
  today date;
  r record;
  new_count int := 0;
begin
  chicago_now := now() at time zone 'America/Chicago';
  chicago_hour := extract(hour from chicago_now);
  chicago_dow := extract(dow from chicago_now);
  today := chicago_now::date;

  if chicago_hour <> 0 then return; end if;
  if chicago_dow in (0,6) then return; end if;
  if exists (select 1 from auto_shipment_runs where run_date = today) then return; end if;

  insert into auto_shipment_runs(run_date) values (today);

  for r in
    select id, name, price, customer_name, pickup_address, pickup_lat, pickup_lng, pickup_notes,
           drop_address, drop_lat, drop_lng, drop_notes, pickup_time, delivery_time
    from payroll_routes
    where active
      and pickup_address is not null and pickup_address <> ''
      and drop_address is not null and drop_address <> ''
  loop
    insert into jobs (job_number, customer_name, pickup_address, pickup_lat, pickup_lng, pickup_notes,
                      drop_address, drop_lat, drop_lng, drop_notes,
                      status, route_id, auto_generated, scheduled_time, scheduled_delivery_time, dispatcher_notes)
    values (
      'BE-AUTO-' || to_char(today,'YYMMDD') || '-' || left(md5(r.id::text || today::text), 5),
      coalesce(r.customer_name, r.name),
      r.pickup_address, r.pickup_lat, r.pickup_lng, r.pickup_notes,
      r.drop_address, r.drop_lat, r.drop_lng, r.drop_notes,
      'pending',
      r.id,
      true,
      case when r.pickup_time is not null then (today + r.pickup_time) at time zone 'America/Chicago' else null end,
      case when r.delivery_time is not null then (today + r.delivery_time) at time zone 'America/Chicago' else null end,
      'Auto-generated daily route shipment — awaiting dispatch assignment'
    )
    on conflict (job_number) do nothing;
    new_count := new_count + 1;
  end loop;

  update auto_shipment_runs set created_count = new_count where run_date = today;
end;
$function$;
