-- Migration 0010 (2026-05-23): admin-configurable packages.
-- Moves pricing out of the hardcoded billing constants into the DB so admins can
-- (a) set one price per speed tier, (b) set IP / IP-block prices, and (c) control
-- which tunnel protocol may sell which speed tier (allow matrix). Seeded with the
-- previous constant values so behaviour is unchanged until an admin edits them.

BEGIN;

-- One price per speed tier (shared across protocols — per design decision).
CREATE TABLE IF NOT EXISTS pricing_speed (
  tier         TEXT PRIMARY KEY,
  price_satang INTEGER NOT NULL CHECK (price_satang >= 0),
  sort_order   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO pricing_speed (tier, price_satang, sort_order) VALUES
  ('tier_100mb', 10000, 1),
  ('tier_500mb', 20000, 2),
  ('tier_1gb',   30000, 3)
ON CONFLICT (tier) DO NOTHING;

-- Which protocol may sell which tier (the allow matrix).
CREATE TABLE IF NOT EXISTS pricing_protocol_tier (
  protocol TEXT NOT NULL,
  tier     TEXT NOT NULL REFERENCES pricing_speed(tier) ON DELETE CASCADE,
  enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (protocol, tier)
);
INSERT INTO pricing_protocol_tier (protocol, tier, enabled)
SELECT p.protocol, s.tier, TRUE
FROM (VALUES ('wireguard'), ('openvpn'), ('sstp')) AS p(protocol)
CROSS JOIN pricing_speed s
ON CONFLICT (protocol, tier) DO NOTHING;

-- IP pricing: block_size 1 = single /32, 2..256 = aligned blocks.
CREATE TABLE IF NOT EXISTS pricing_ip (
  block_size   INTEGER PRIMARY KEY,
  price_satang INTEGER NOT NULL CHECK (price_satang >= 0)
);
INSERT INTO pricing_ip (block_size, price_satang) VALUES
  (1, 10000), (2, 20000), (4, 40000), (8, 80000),
  (16, 150000), (32, 280000), (64, 520000), (128, 980000), (256, 1800000)
ON CONFLICT (block_size) DO NOTHING;

COMMIT;
