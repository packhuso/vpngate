-- Migration 0011 (2026-05-23): per-item locked price (grandfathering).
-- A customer keeps the price they bought at — regardless of later admin price
-- changes — until they cancel the item and buy again. We snapshot the price onto
-- each billable row at purchase; recurring charges use the snapshot, not the
-- live catalog price. ip_blocks already has price_satang; add it to tunnels and
-- standalone public_ips, backfilling existing rows from the current catalog.

BEGIN;

ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS price_satang INTEGER;
UPDATE tunnels t
   SET price_satang = ps.price_satang
  FROM pricing_speed ps
 WHERE ps.tier = t.speed_tier::text AND t.price_satang IS NULL;

-- Only standalone IPs (block_id IS NULL) are billed individually; block members
-- are billed via their ip_blocks row, so they don't need a per-IP price.
ALTER TABLE public_ips ADD COLUMN IF NOT EXISTS price_satang INTEGER;
UPDATE public_ips
   SET price_satang = (SELECT price_satang FROM pricing_ip WHERE block_size = 1)
 WHERE block_id IS NULL AND price_satang IS NULL;

COMMIT;
