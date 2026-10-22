-- Maintenance records: repair invoices, their line items, and a private place for the original receipts.

-- 1) Invoices (one row per receipt)
create table if not exists public.repair_invoices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null default 'upload' check (source in ('upload','email','manual')),
  status text not null default 'review' check (status in ('review','approved','rejected')),
  vehicle_id uuid references public.vehicles(id) on delete set null,
  unit_text text check (char_length(unit_text) <= 40),
  vendor text check (char_length(vendor) <= 200),
  invoice_number text check (char_length(invoice_number) <= 80),
  invoice_date date,
  odometer integer check (odometer >= 0),
  subtotal numeric(12,2),
  tax numeric(12,2),
  total numeric(12,2),
  summary text check (char_length(summary) <= 2000),
  notes text check (char_length(notes) <= 4000),
  file_path text,
  file_name text check (char_length(file_name) <= 200),
  email_from text check (char_length(email_from) <= 300),
  email_subject text check (char_length(email_subject) <= 300),
  ai_confidence text check (ai_confidence in ('high','medium','low')),
  approved_by text,
  approved_at timestamptz
);
create index if not exists repair_invoices_vehicle_idx on public.repair_invoices (vehicle_id, invoice_date desc);
create index if not exists repair_invoices_status_idx on public.repair_invoices (status, created_at desc);

-- 2) Line items (parts, labor, other)
create table if not exists public.repair_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.repair_invoices(id) on delete cascade,
  sort_order integer not null default 0,
  kind text not null default 'part' check (kind in ('part','labor','other')),
  category text check (char_length(category) <= 60),
  description text check (char_length(description) <= 500),
  part_number text check (char_length(part_number) <= 80),
  quantity numeric(10,2),
  unit_price numeric(12,2),
  amount numeric(12,2)
);
create index if not exists repair_lines_invoice_idx on public.repair_lines (invoice_id, sort_order);

alter table public.repair_invoices enable row level security;
alter table public.repair_lines enable row level security;
revoke all on public.repair_invoices, public.repair_lines from anon;

drop policy if exists "staff manage repair_invoices" on public.repair_invoices;
create policy "staff manage repair_invoices" on public.repair_invoices for all to authenticated
  using (get_my_role() in ('admin','dispatcher')) with check (get_my_role() in ('admin','dispatcher'));
drop policy if exists "staff manage repair_lines" on public.repair_lines;
create policy "staff manage repair_lines" on public.repair_lines for all to authenticated
  using (get_my_role() in ('admin','dispatcher')) with check (get_my_role() in ('admin','dispatcher'));

-- deleting needs the "delete data" right (same rule as the rest of the portal)
drop policy if exists "delete needs right" on public.repair_invoices;
create policy "delete needs right" on public.repair_invoices as restrictive for delete using (public.has_right('delete'));
drop policy if exists "delete needs right" on public.repair_lines;
create policy "delete needs right" on public.repair_lines as restrictive for delete using (public.has_right('delete'));

-- 3) Private bucket for the original receipts (PDF / photos). Only staff can see them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 15000000,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

drop policy if exists "receipts staff read" on storage.objects;
create policy "receipts staff read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and get_my_role() in ('admin','dispatcher'));
drop policy if exists "receipts staff upload" on storage.objects;
create policy "receipts staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and get_my_role() in ('admin','dispatcher'));
-- receipts are records: only people with the delete right can remove them
drop policy if exists "receipts staff delete" on storage.objects;
create policy "receipts staff delete" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and public.has_right('delete'));
drop policy if exists "receipts delete needs right" on storage.objects;
create policy "receipts delete needs right" on storage.objects as restrictive for delete
  using (bucket_id <> 'receipts' or public.has_right('delete'));
