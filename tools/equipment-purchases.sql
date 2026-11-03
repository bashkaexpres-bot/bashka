-- Equipment purchases (Maintenance > Equipment). Run ONCE in the Supabase SQL editor. Safe to re-run.
-- Staff (admin + dispatcher) can view and add. Only people given the "equipment" right on the Team page can edit or delete.

create table if not exists public.equipment_purchases (
  id uuid primary key default gen_random_uuid(),
  purchased_on date not null,
  item text not null check (char_length(item) between 1 and 200),
  category text check (char_length(category) <= 60),
  vendor text check (char_length(vendor) <= 200),
  quantity numeric(10,2) not null default 1 check (quantity > 0),
  unit_price numeric(12,2) check (unit_price >= 0),
  total numeric(12,2) not null check (total >= 0),
  for_unit text check (char_length(for_unit) <= 60),
  receipt_path text,
  receipt_name text check (char_length(receipt_name) <= 200),
  notes text check (char_length(notes) <= 2000),
  created_by uuid default auth.uid(),
  created_by_name text check (char_length(created_by_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists equipment_purchases_date_idx on public.equipment_purchases (purchased_on desc);

alter table public.equipment_purchases enable row level security;
revoke all on public.equipment_purchases from anon;
grant select, insert, update, delete on public.equipment_purchases to authenticated;  -- row rules below limit who can do what

drop policy if exists equip_staff_read on public.equipment_purchases;
create policy equip_staff_read on public.equipment_purchases for select to authenticated
  using (get_my_role() = any (array['admin','dispatcher']));

drop policy if exists equip_staff_add on public.equipment_purchases;
create policy equip_staff_add on public.equipment_purchases for insert to authenticated
  with check (get_my_role() = any (array['admin','dispatcher']));

-- edit / delete: only people who were given the "equipment" right (the owner always has it)
drop policy if exists equip_right_edit on public.equipment_purchases;
create policy equip_right_edit on public.equipment_purchases for update to authenticated
  using (get_my_role() = any (array['admin','dispatcher']) and public.has_right('equipment'))
  with check (get_my_role() = any (array['admin','dispatcher']) and public.has_right('equipment'));

drop policy if exists equip_right_delete on public.equipment_purchases;
create policy equip_right_delete on public.equipment_purchases for delete to authenticated
  using (get_my_role() = any (array['admin','dispatcher']) and public.has_right('equipment'));
