-- Record types for maintenance records: repair (default), rental, parts bought, truck wash.
-- Rentals, parts and washes with no truck/trailer are counted as fleet costs.
-- Safe to run more than once (also upgrades the earlier 3-type version).
alter table public.repair_invoices
  add column if not exists record_type text not null default 'repair';
alter table public.repair_invoices drop constraint if exists repair_invoices_record_type_check;
alter table public.repair_invoices
  add constraint repair_invoices_record_type_check check (record_type in ('repair','rental','parts','wash'));
create index if not exists repair_invoices_type_idx on public.repair_invoices (record_type, invoice_date desc);
