-- Migration 0001 (2026-05-20): expand block_size to include 2 (/31) + 4 (/30),
-- add public_ips.sale_mode so admin can mark IPs as single-only / block-only.

BEGIN;

-- 1. relax ip_blocks.block_size CHECK to include 2 and 4
ALTER TABLE ip_blocks DROP CONSTRAINT IF EXISTS valid_block_size;
ALTER TABLE ip_blocks ADD CONSTRAINT valid_block_size
  CHECK (block_size IN (2, 4, 8, 16, 32, 64, 128, 256));

-- 2. public_ips.sale_mode — admin policy for how each /32 can be sold.
--    'single'     → sellable as a single /32 (default)
--    'block_only' → reserved for block sale only (won't appear in singles list)
--    'reserved'   → admin-held, never auto-allocated
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'public_ips' AND column_name = 'sale_mode'
  ) THEN
    ALTER TABLE public_ips
      ADD COLUMN sale_mode VARCHAR(20) NOT NULL DEFAULT 'single'
      CHECK (sale_mode IN ('single', 'block_only', 'reserved'));
    CREATE INDEX idx_ips_sale_mode ON public_ips(sale_mode)
      WHERE status = 'available';
  END IF;
END $$;

COMMIT;
