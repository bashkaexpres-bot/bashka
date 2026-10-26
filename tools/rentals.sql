-- Record types for maintenance records: repair (default), rental, parts bought, truck wash, parking, other expense.
-- Anything that is not a repair and has no truck/trailer is counted as a fleet cost.
-- Safe to run more than once (also upgrades the earlier versions).
alter table public.repair_invoices
  add column if not exists record_type text not null default 'repair';
alter table public.repair_invoices drop constraint if exists repair_invoices_record_type_check;
alter table public.repair_invoices
  add constraint repair_invoices_record_type_check check (record_type in ('repair','rental','parts','wash','parking','other'));
create index if not exists repair_invoices_type_idx on public.repair_invoices (record_type, invoice_date desc);
