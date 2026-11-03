-- Adds the 3 Hino trucks from Midwest Regional Auction invoice 2026328 (event Sep 24, 2026) to Equipment purchases.
-- Run ONCE in the Supabase SQL editor. Adds 3 rows only; nothing else changes.
-- Afterwards: Maintenance > Equipment > edit each row to attach the invoice PDF as the receipt.
insert into public.equipment_purchases (purchased_on, item, category, vendor, quantity, unit_price, total, for_unit, notes, created_by_name)
select * from (values
  (date '2026-09-24', '2015 Hino 268 4x2 Van Truck (Lot 2135)', 'Truck purchase', 'Midwest Regional Auction', 1::numeric, 14425.00::numeric, 14425.00::numeric, 'S/N ...S53919',
   'Invoice 2026328. Price 13,000 + doc fee 125 + transaction fee 1,300 + tax 0. Pick-up: South Vienna, OH.', 'Added by Claude from invoice'),
  (date '2026-09-24', '2015 Hino 268 4x2 Van Truck (Lot 2137)', 'Truck purchase', 'Midwest Regional Auction', 1, 16718.75, 16718.75, 'S/N ...S53985',
   'Invoice 2026328. Price 15,000 + doc fee 125 + transaction fee 1,500 + tax 93.75. Pick-up: Morris, IL.', 'Added by Claude from invoice'),
  (date '2026-09-24', '2015 Hino 268 4x2 Van Truck (Lot 2139)', 'Truck purchase', 'Midwest Regional Auction', 1, 14759.88, 14759.88, 'S/N ...S53976',
   'Invoice 2026328. Price 13,000 + doc fee 125 + interest 206.98 + transaction fee 1,300 + tax 127.90. Pick-up: Odessa, MO.', 'Added by Claude from invoice')
) as v(purchased_on, item, category, vendor, quantity, unit_price, total, for_unit, notes, created_by_name)
where not exists (select 1 from public.equipment_purchases where item like '%(Lot 2135)%' and vendor = 'Midwest Regional Auction');
