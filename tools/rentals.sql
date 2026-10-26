-- Rentals and parts bought: a record type on each maintenance record.
-- repair = shop work (what you have now), rental = rented truck/equipment, parts = parts or supplies you bought.
-- Rentals and parts with no truck/trailer are counted as fleet costs.
alter table public.repair_invoices
  add column if not exists record_type text not null default 'repair'
  check (record_type in ('repair','rental','parts'));
create index if not exists repair_invoices_type_idx on public.repair_invoices (record_type, invoice_date desc);
