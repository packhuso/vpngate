-- Migration 0002 (2026-05-20): admin-defined IP sale plans.
-- A "sale plan" is a sub-CIDR within an ip_pool that the admin marks as
-- sellable as either single /32s OR as aligned blocks of a fixed prefix size.
-- Multiple non-overlapping plans per pool, evaluated in declared order.
-- Backward compat: if a pool has zero plans, the buy logic falls back to
-- "all-single" mode (the legacy behaviour).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='ip_sale_mode') THEN
    CREATE TYPE ip_sale_mode AS ENUM ('single', 'block');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ip_sale_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id     UUID NOT NULL REFERENCES ip_pool(id) ON DELETE CASCADE,
  cidr        CIDR NOT NULL,
  sale_mode   ip_sale_mode NOT NULL,
  block_size  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT block_size_valid CHECK (
    (sale_mode = 'block'  AND block_size IS NOT NULL
       AND block_size IN (2, 4, 8, 16, 32, 64, 128, 256))
    OR
    (sale_mode = 'single' AND block_size IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ip_sale_plans_pool ON ip_sale_plans(pool_id);
CREATE INDEX IF NOT EXISTS idx_ip_sale_plans_cidr ON ip_sale_plans USING gist (cidr inet_ops);

COMMIT;
